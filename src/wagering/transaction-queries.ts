// Consultas de leitura de transações. Ficam fora do caminho de escrita: não travam nada.

import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { TransactionNotFoundError } from '../application-errors';
import { transactionToDomain } from '../database/mappers';
import { WagerTransactionRecord, WalletRecord } from '../database/records';
import type { FailureCode } from '../domain/failure-code';
import { isUuid } from '../domain/id';
import type { MoneyProps } from '../domain/money';
import type { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  /** Saldo da wallet observado quando a transação terminou. */
  balanceAfter?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

@Injectable()
export class TransactionQueries {
  constructor(private readonly orm: MikroORM) {}

  /** Pelo id interno. Um id que não é UUID responde 404 sem consultar o banco. */
  async byId(transactionId: string): Promise<WagerTransactionView> {
    const record = isUuid(transactionId)
      ? await this.orm.em.fork().findOne(WagerTransactionRecord, { id: transactionId })
      : null;
    return this.toView(record, transactionId);
  }

  /** Pelo id do provedor: é como o provedor consulta uma operação sem conhecer o nosso id. */
  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return this.toView(record, `${providerId}/${externalTransactionId}`);
  }

  private async toView(record: WagerTransactionRecord | null, description: string): Promise<WagerTransactionView> {
    if (!record) {
      throw new TransactionNotFoundError(description);
    }
    const wallet = await this.orm.em.fork().findOneOrFail(WalletRecord, { id: record.walletId });
    const tx = transactionToDomain(record, wallet.currency);
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      ...(tx.failureCode !== undefined && { failureCode: tx.failureCode }),
      ...(tx.referenceExternalTransactionId !== undefined && { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
      ...(tx.referenceTransactionId !== undefined && { referenceTransactionId: tx.referenceTransactionId }),
      ...(tx.resultBalance !== undefined && { balanceAfter: tx.resultBalance.toJSON() }),
      createdAt: tx.createdAt.toISOString(),
      ...(tx.processedAt !== undefined && { processedAt: tx.processedAt.toISOString() }),
    };
  }
}
