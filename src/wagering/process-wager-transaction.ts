import { LockMode } from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  IdempotencyKeyConflictError,
  NotSupportedYetError,
  WalletNotFoundError,
} from '../application-errors';
import {
  copyWalletState,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
} from '../database/mappers';
import { WagerTransactionRecord, WalletRecord } from '../database/records';
import { FailureCode } from '../domain/failure-code';
import { isUuid } from '../domain/id';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../domain/integration-events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { Metrics } from '../metrics/metrics';
import { computePayloadHash, type WagerPayload } from './payload-hash';

/** Entrada independente de transporte: usada pela API HTTP e pelo consumidor SQS (Fase 6). */
export interface ProcessWagerTransactionCommand extends WagerPayload {
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const stopTimer = this.metrics.processingSeconds.startTimer({ kind: command.kind });

    // Validação do payload antes de tocar no banco: erro aqui é payload inválido (HTTP 400).
    const transaction = WagerTransaction.create({
      ...command,
      kind: command.kind as WagerTransactionKind,
      money: Money.from(command.money),
      payloadHash: computePayloadHash(command),
    });
    if (!isUuid(command.walletId)) {
      throw new WalletNotFoundError(command.walletId);
    }

    // Uma wallet = uma transação SQL. Cada execução usa seu próprio EntityManager (fork).
    const result = await this.orm.em.fork().transactional(async (em) => {
      // 1. Lock da wallet: serializa todas as operações desta wallet, em qualquer instância.
      const walletRecord = await this.lockWallet(em, command.walletId);

      // 2. A chave já foi usada? (caminho normal de replay/conflito: a linha já está commitada)
      const existing = await em.findOne(WagerTransactionRecord, { idempotencyKey: command.idempotencyKey });
      if (existing) {
        return this.replayOrConflict(existing, transaction, walletRecord);
      }

      if (transaction.referenceExternalTransactionId !== undefined) {
        throw new NotSupportedYetError(`${transaction.kind} with reference is not supported yet (resolution arrives in phase 5)`);
      }

      // 3. Decide em memória (o agregado ainda não foi persistido).
      const wallet = walletToDomain(walletRecord);
      const at = new Date();
      const ledgerEntry = this.apply(wallet, transaction, at);

      // 4. Grava a transação ANTES de qualquer mudança de saldo. Se a chave (ou o external id)
      //    foi gravada por outra transação concorrente, nada é inserido e nada mais é escrito.
      if (!(await this.insertTransaction(em, transaction))) {
        return this.resolveInsertConflict(em, transaction, walletRecord);
      }

      // 5. Só agora: lançamento, saldo/version e eventos na outbox, na mesma transação SQL.
      if (ledgerEntry) {
        em.persist(ledgerEntryToRecord(ledgerEntry));
        copyWalletState(wallet, walletRecord);
      }
      for (const event of this.eventsFor(wallet, transaction, ledgerEntry, command, at)) {
        em.persist(outboxToRecord(OutboxMessage.enqueue(event)));
      }
      await em.flush();
      await this.beforeCommit(em);

      return this.toResult(transaction, wallet.balance, false);
    });

    stopTimer();
    if (!result.idempotentReplay) {
      this.metrics.transactions.inc({ kind: transaction.kind, status: result.status });
    }
    this.logger.log({
      message: 'wager transaction handled',
      correlationId: command.correlationId,
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      kind: transaction.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
    return result;
  }

  /**
   * SELECT ... FOR UPDATE na linha da wallet: serializa só as operações desta wallet.
   * Primeiro tenta com SKIP LOCKED para saber, sem erro e sem abortar a transação, se outra
   * transação já segura o lock; nesse caso conta um conflito e espera com FOR UPDATE normal.
   */
  private async lockWallet(em: EntityManager, walletId: string): Promise<WalletRecord> {
    const free = await em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE });
    if (free) {
      return free;
    }
    const locked = await em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!locked) {
      throw new WalletNotFoundError(walletId);
    }
    this.metrics.lockConflicts.inc();
    return locked;
  }

  /** Mesmo hash → resultado original (replay). Hash diferente → 409, nunca replay. */
  private replayOrConflict(
    existing: WagerTransactionRecord,
    incoming: WagerTransaction,
    walletRecord: WalletRecord,
  ): WagerTransactionResult {
    if (existing.payloadHash !== incoming.payloadHash) {
      this.metrics.duplicates.inc({ type: 'idempotency_key_conflict' });
      throw new IdempotencyKeyConflictError(incoming.idempotencyKey);
    }
    this.metrics.duplicates.inc({ type: 'replay' });
    // Mesmo hash implica mesma walletId (faz parte do hash): a wallet travada é a da transação original.
    const original = transactionToDomain(existing, walletRecord.currency);
    return this.toResult(original, Money.from({ amount: walletRecord.balance, currency: walletRecord.currency }), true);
  }

  /**
   * O INSERT não inseriu: outra transação SQL gravou a mesma chave ou o mesmo
   * (providerId, externalTransactionId) — típico de chaves iguais disputando wallets diferentes,
   * que não compartilham lock. O PostgreSQL esperou o commit dela, então a linha já é visível.
   */
  private async resolveInsertConflict(
    em: EntityManager,
    incoming: WagerTransaction,
    walletRecord: WalletRecord,
  ): Promise<WagerTransactionResult> {
    const byKey = await em.findOne(WagerTransactionRecord, { idempotencyKey: incoming.idempotencyKey });
    if (byKey) {
      return this.replayOrConflict(byKey, incoming, walletRecord);
    }
    const byExternalId = await em.findOne(WagerTransactionRecord, {
      providerId: incoming.providerId,
      externalTransactionId: incoming.externalTransactionId,
    });
    if (byExternalId) {
      this.metrics.duplicates.inc({ type: 'duplicate_external_transaction' });
      throw new DuplicateExternalTransactionError(incoming.providerId, incoming.externalTransactionId);
    }
    throw new Error(`Insert of transaction ${incoming.id} conflicted but no conflicting row was found`);
  }

  /** INSERT ... ON CONFLICT DO NOTHING RETURNING: conflito não aborta a transação SQL, só não insere. */
  private async insertTransaction(em: EntityManager, transaction: WagerTransaction): Promise<boolean> {
    const r = transactionToRecord(transaction);
    const rows = await em.getConnection().execute<{ id: string }[]>(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, result_balance, created_at, processed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        r.id, r.providerId, r.externalTransactionId, r.idempotencyKey, r.payloadHash, r.walletId, r.playerId,
        r.roundId, r.gameId, r.kind, r.amount, r.currency, r.referenceExternalTransactionId,
        r.referenceTransactionId, r.status, r.failureCode, r.resultBalance, r.createdAt, r.processedAt,
      ],
      'all',
      em.getTransactionContext(),
    );
    return rows.length === 1;
  }

  /**
   * Regras de negócio, só em memória. Rejeição NÃO é exceção: a transação termina REJECTED e
   * é gravada (com commit) para ficar auditável; nesse caso não há lançamento nem mudança de saldo.
   */
  private apply(wallet: Wallet, transaction: WagerTransaction, at: Date): WalletLedgerEntry | undefined {
    if (transaction.playerId !== wallet.playerId) {
      transaction.reject(FailureCode.PlayerMismatch, at, wallet.balance);
      return undefined;
    }
    if (transaction.money.currency !== wallet.currency) {
      transaction.reject(FailureCode.CurrencyMismatch, at, wallet.balance);
      return undefined;
    }

    const movement = { transactionId: transaction.id, at };
    let entry: WalletLedgerEntry | undefined;
    switch (transaction.kind) {
      case WagerTransactionKind.Bet:
        if (!wallet.canDebit(transaction.money)) {
          transaction.reject(FailureCode.InsufficientFunds, at, wallet.balance);
          return undefined;
        }
        entry = wallet.debit(transaction.money, movement);
        break;
      case WagerTransactionKind.Win:
        entry = wallet.credit(transaction.money, movement);
        break;
      case WagerTransactionKind.Loss:
        entry = undefined;
        break;
      default:
        throw new NotSupportedYetError(`${transaction.kind} is not supported yet`);
    }
    transaction.markProcessed(undefined, at, wallet.balance);
    return entry;
  }

  private eventsFor(
    wallet: Wallet,
    transaction: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    command: ProcessWagerTransactionCommand,
    at: Date,
  ): IntegrationEvent<unknown>[] {
    const ctx: EventContext = { correlationId: command.correlationId, causationId: command.causationId, at };
    if (transaction.status === WagerTransactionStatus.Rejected) {
      return [WagerTransactionRejected.from(transaction, ctx)];
    }
    const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(transaction, ctx)];
    if (entry) {
      events.push(WalletBalanceChanged.from(wallet, entry, ctx));
    }
    return events;
  }

  /** `currentBalance` só é usado quando a transação ainda não terminou (PENDING_REFERENCE): estado atual. */
  private toResult(transaction: WagerTransaction, currentBalance: Money, idempotentReplay: boolean): WagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(transaction.failureCode !== undefined && { failureCode: transaction.failureCode }),
      balance: (transaction.resultBalance ?? currentBalance).toJSON(),
      idempotentReplay,
    };
  }

  /**
   * Chamado depois de todas as escritas e antes do commit. Não faz nada em produção; os testes
   * sobrescrevem para simular uma falha (ou uma pausa) no meio e provar atomicidade/isolamento.
   */
  protected async beforeCommit(_em: EntityManager): Promise<void> {}
}
