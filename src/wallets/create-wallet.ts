import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { DuplicateWalletError } from '../application-errors';
import { ledgerEntryToRecord, outboxToRecord, transactionToRecord, walletToRecord } from '../database/mappers';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/integration-events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWallet {
  private readonly logger = new Logger(CreateWallet.name);

  constructor(private readonly orm: MikroORM) {}

  /** Wallet + transação OPENING + lançamento CREDIT + eventos na outbox: tudo na mesma transação SQL. */
  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const at = new Date();
    const wallet = Wallet.open({ playerId: command.playerId, initialBalance, at });

    try {
      await this.orm.em.fork().transactional(async (em) => {
        em.persist(walletToRecord(wallet));
        await em.flush();

        if (!initialBalance.isPositive()) {
          return; // saldo zero: sem OPENING e sem lançamento
        }
        const opening = WagerTransaction.opening({ walletId: wallet.id, playerId: wallet.playerId, money: initialBalance });
        const entry = wallet.openingEntry({ transactionId: opening.id, at });
        opening.markProcessed(undefined, at, wallet.balance);

        em.persist(transactionToRecord(opening));
        await em.flush();
        em.persist(ledgerEntryToRecord(entry));
        const ctx = { correlationId: command.correlationId, at };
        em.persist(outboxToRecord(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx))));
        em.persist(outboxToRecord(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx))));
      });
    } catch (error) {
      // A unique (player_id, currency) do banco é quem garante "uma wallet por player e moeda".
      if (error instanceof UniqueConstraintViolationException) {
        throw new DuplicateWalletError(wallet.playerId, wallet.currency);
      }
      throw error;
    }

    this.logger.log({ message: 'wallet opened', correlationId: command.correlationId, walletId: wallet.id });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
