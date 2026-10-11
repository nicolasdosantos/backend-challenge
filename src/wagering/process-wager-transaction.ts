import { LockMode } from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  IdempotencyKeyConflictError,
  InboxPayloadConflictError,
  WalletNotFoundError,
} from '../application-errors';
import { APP_CONFIG, type AppConfig } from '../config';
import {
  copyTransactionState,
  copyWalletState,
  inboxToRecord,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
} from '../database/mappers';
import { InboxMessageRecord, WagerTransactionRecord, WalletRecord } from '../database/records';
import { FailureCode } from '../domain/failure-code';
import { isUuid } from '../domain/id';
import { InboxMessage } from '../domain/inbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../domain/integration-events';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { Metrics } from '../metrics/metrics';
import { computePayloadHash, type WagerPayload } from './payload-hash';
import { nextReferenceAttemptAt, referenceRetriesExhausted, type ReferenceRetryPolicy } from './reference-retry-policy';

/** Entrada independente de transporte: usada pela API HTTP e pelo consumidor SQS. */
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

/** Mensagem SQS que originou o comando: (consumidor, messageId) identifica a entrega na inbox. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
}

/** A mensagem já foi processada antes (redelivery): nada a fazer além do ack. */
export const DUPLICATE_DELIVERY = 'duplicate_delivery' as const;

/** Resultado do reprocessamento de uma transação em PENDING_REFERENCE. */
export type PendingReferenceOutcome = 'processed' | 'rejected' | 'still_pending' | 'skipped';

/**
 * Resultado da avaliação. `pending`: a referência ainda não existe (`missing`) ou existe mas
 * não terminou de processar (`unfinished`); a transação não foi alterada.
 */
type Evaluation =
  | { pending: false; ledgerEntry?: WalletLedgerEntry }
  | { pending: true; waitingOn: 'missing' | 'unfinished' };

@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);
  private readonly retryPolicy: ReferenceRetryPolicy;

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.retryPolicy = config.pendingReference;
  }

  /** Entrada HTTP. */
  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const outcome = await this.process(command, undefined);
    if (outcome === DUPLICATE_DELIVERY) {
      throw new Error('Unreachable: duplicate delivery without inbox');
    }
    return outcome;
  }

  /**
   * Entrada SQS: o registro na inbox `(consumerName, messageId)` entra na MESMA transação SQL
   * do processamento. Se a mensagem já foi processada (redelivery), devolve DUPLICATE_DELIVERY
   * sem reprocessar; se o mesmo messageId chegar com outro payload, é erro permanente.
   */
  async executeFromMessage(
    command: ProcessWagerTransactionCommand,
    inbox: InboxContext,
  ): Promise<WagerTransactionResult | typeof DUPLICATE_DELIVERY> {
    return this.process(command, inbox);
  }

  private async process(
    command: ProcessWagerTransactionCommand,
    inbox: InboxContext | undefined,
  ): Promise<WagerTransactionResult | typeof DUPLICATE_DELIVERY> {
    const stopTimer = this.metrics.processingSeconds.startTimer({ kind: command.kind });

    // Validação do payload antes de tocar no banco: erro aqui é payload inválido (HTTP 400 / DLQ).
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
      // 0. Inbox (só via SQS): se não inseriu, esta mensagem já foi processada e commitada.
      //    Com duas entregas simultâneas, a segunda espera o commit da primeira neste INSERT.
      if (inbox && !(await this.insertInbox(em, inbox, transaction.payloadHash))) {
        return this.checkDuplicateDelivery(em, inbox, transaction.payloadHash);
      }

      // 1. Lock da wallet: serializa todas as operações desta wallet, em qualquer instância.
      const walletRecord = await this.lockWallet(em, command.walletId);

      // 2. A chave já foi usada? Replay (estado atual) ou conflito.
      const existing = await em.findOne(WagerTransactionRecord, { idempotencyKey: command.idempotencyKey });
      if (existing) {
        return this.replayOrConflict(existing, transaction, walletRecord);
      }

      // 3. Decide em memória: só leituras (referência), nenhuma escrita ainda.
      const wallet = walletToDomain(walletRecord);
      const at = new Date();
      const evaluation = await this.evaluate(em, wallet, transaction, at);
      if (evaluation.pending) {
        transaction.markPendingReference(nextReferenceAttemptAt(this.retryPolicy, 0, at));
      }

      // 4. Grava a transação ANTES de qualquer mudança de saldo. Se a chave (ou o external id)
      //    foi gravada por outra transação concorrente, nada é inserido e nada mais é escrito.
      if (!(await this.insertTransaction(em, transaction))) {
        return this.resolveInsertConflict(em, transaction, walletRecord);
      }

      // 5. Só agora: lançamento, saldo/version e eventos na outbox, na mesma transação SQL.
      this.persistEffects(em, wallet, walletRecord, transaction, evaluation, {
        correlationId: command.correlationId,
        causationId: command.causationId,
        at,
      });
      await em.flush();
      await this.beforeCommit(em);

      return this.toResult(transaction, wallet.balance, false);
    });

    stopTimer();
    if (result === DUPLICATE_DELIVERY) {
      this.metrics.duplicates.inc({ type: 'inbox' });
      this.logger.log({
        message: 'duplicate delivery ignored',
        correlationId: command.correlationId,
        messageId: inbox?.messageId,
        walletId: command.walletId,
        providerId: command.providerId,
      });
      return result;
    }
    if (!result.idempotentReplay) {
      this.metrics.transactions.inc({ kind: transaction.kind, status: result.status });
    }
    this.logger.log({
      message: 'wager transaction handled',
      correlationId: command.correlationId,
      messageId: inbox?.messageId,
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
   * Registra a transação como FAILED (INTERNAL_ERROR) quando o processamento falhou por um erro
   * inesperado e não recuperável (o consumidor chama na última tentativa, antes de mandar à DLQ).
   * Transação SQL separada, sem lançamento nem mudança de saldo: só deixa a falha auditável.
   * Não grava nada se a wallet não existe ou se a chave já tem uma transação registrada.
   */
  async recordFailure(command: ProcessWagerTransactionCommand): Promise<string | undefined> {
    const transaction = WagerTransaction.create({
      ...command,
      kind: command.kind as WagerTransactionKind,
      money: Money.from(command.money),
      payloadHash: computePayloadHash(command),
    });
    transaction.fail(FailureCode.InternalError, new Date());
    const recorded = await this.orm.em.fork().transactional(async (em) => {
      const wallet = await em.findOne(WalletRecord, { id: command.walletId });
      return wallet !== null && (await this.insertTransaction(em, transaction));
    });
    if (!recorded) {
      return undefined;
    }
    this.metrics.transactions.inc({ kind: transaction.kind, status: transaction.status });
    this.logger.error({
      message: 'wager transaction failed',
      correlationId: command.correlationId,
      transactionId: transaction.id,
      walletId: command.walletId,
      providerId: command.providerId,
      failureCode: transaction.failureCode,
    });
    return transaction.id;
  }

  /** INSERT ... ON CONFLICT DO NOTHING na inbox, na transação corrente. */
  private async insertInbox(em: EntityManager, inbox: InboxContext, payloadHash: string): Promise<boolean> {
    const message = InboxMessage.receive({ ...inbox, payloadHash, at: new Date() });
    message.markProcessed(message.receivedAt); // processado nesta mesma transação SQL
    const r = inboxToRecord(message);
    const rows = await em.getConnection().execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict do nothing
       returning message_id`,
      [r.consumerName, r.messageId, r.payloadHash, r.receivedAt, r.processedAt],
      'all',
      em.getTransactionContext(),
    );
    return rows.length === 1;
  }

  private async checkDuplicateDelivery(
    em: EntityManager,
    inbox: InboxContext,
    payloadHash: string,
  ): Promise<typeof DUPLICATE_DELIVERY> {
    const existing = await em.findOne(InboxMessageRecord, { consumerName: inbox.consumerName, messageId: inbox.messageId });
    if (existing && existing.payloadHash !== payloadHash) {
      this.metrics.duplicates.inc({ type: 'inbox_payload_conflict' });
      throw new InboxPayloadConflictError(inbox.messageId);
    }
    return DUPLICATE_DELIVERY;
  }

  /**
   * Reavalia uma transação em PENDING_REFERENCE (chamado pelo worker). Mesma ordem de locks do
   * caminho principal: wallet (FOR UPDATE) e só então a transação, que é RELIDA dentro do lock.
   * Se outro worker/instância já a resolveu ou reagendou, não faz nada ('skipped').
   */
  async retryPendingReference(transactionId: string, walletId: string): Promise<PendingReferenceOutcome> {
    const outcome = await this.orm.em.fork().transactional(async (em): Promise<{
      outcome: PendingReferenceOutcome;
      transaction?: WagerTransaction;
    }> => {
      const walletRecord = await this.lockWallet(em, walletId);
      const record = await em.findOne(WagerTransactionRecord, { id: transactionId });
      const now = new Date();
      if (
        !record ||
        record.status !== WagerTransactionStatus.PendingReference ||
        !record.nextReferenceAttemptAt ||
        record.nextReferenceAttemptAt > now
      ) {
        return { outcome: 'skipped' };
      }

      const wallet = walletToDomain(walletRecord);
      const transaction = transactionToDomain(record, wallet.currency);
      const evaluation = await this.evaluate(em, wallet, transaction, now);

      let outcome: PendingReferenceOutcome;
      if (!evaluation.pending) {
        outcome = transaction.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
      } else if (referenceRetriesExhausted(this.retryPolicy, transaction.referenceAttempts)) {
        const code = evaluation.waitingOn === 'missing' ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed;
        transaction.reject(code, now, wallet.balance);
        outcome = 'rejected';
      } else {
        transaction.scheduleReferenceRetry(
          nextReferenceAttemptAt(this.retryPolicy, transaction.referenceAttempts + 1, now),
        );
        outcome = 'still_pending';
      }

      copyTransactionState(transaction, record);
      if (outcome !== 'still_pending') {
        const resolved: Evaluation = evaluation.pending ? { pending: false } : evaluation;
        // Sem a requisição original, a transação é o próprio identificador de rastreio.
        this.persistEffects(em, wallet, walletRecord, transaction, resolved, {
          correlationId: transaction.id,
          causationId: transaction.id,
          at: now,
        });
      }
      await em.flush();
      return { outcome, transaction };
    });

    this.metrics.pendingReferenceRetries.inc({ outcome: outcome.outcome });
    if (outcome.transaction && (outcome.outcome === 'processed' || outcome.outcome === 'rejected')) {
      this.metrics.transactions.inc({ kind: outcome.transaction.kind, status: outcome.transaction.status });
    }
    if (outcome.outcome !== 'skipped') {
      this.logger.log({
        message: 'pending reference re-evaluated',
        correlationId: transactionId,
        transactionId,
        walletId,
        outcome: outcome.outcome,
        failureCode: outcome.transaction?.failureCode,
      });
    }
    return outcome.outcome;
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

  /**
   * Regras de negócio. Rejeição NÃO é exceção: a transação termina REJECTED e é gravada (com
   * commit) para ficar auditável; nesse caso não há lançamento nem mudança de saldo.
   * Só faz leituras no banco; o efeito fica no agregado em memória até o chamador persistir.
   */
  private async evaluate(em: EntityManager, wallet: Wallet, transaction: WagerTransaction, at: Date): Promise<Evaluation> {
    const reject = (code: FailureCode): Evaluation => {
      transaction.reject(code, at, wallet.balance);
      return { pending: false };
    };
    if (transaction.playerId !== wallet.playerId) {
      return reject(FailureCode.PlayerMismatch);
    }
    if (transaction.money.currency !== wallet.currency) {
      return reject(FailureCode.CurrencyMismatch);
    }

    // Referência (WIN/LOSS opcional, REFUND/ROLLBACK obrigatória): resolvida por (providerId, externalTransactionId).
    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      const referenceRecord = await em.findOne(WagerTransactionRecord, {
        providerId: transaction.providerId,
        externalTransactionId: transaction.referenceExternalTransactionId,
      });
      if (!referenceRecord) {
        return { pending: true, waitingOn: 'missing' };
      }
      reference = transactionToDomain(referenceRecord, wallet.currency);
      const check = transaction.checkReference(reference);
      if (check.outcome === 'wait') {
        return { pending: true, waitingOn: 'unfinished' };
      }
      if (check.outcome === 'invalid') {
        return reject(check.failureCode);
      }
      // Regra estrita: uma referência aceita UMA reversão processada. Checado aqui, dentro do lock
      // da wallet (a referência é da mesma wallet); o índice único parcial é a última barreira.
      if (transaction.isReversal() && (await this.isAlreadyReversed(em, reference.id))) {
        return reject(FailureCode.AlreadyReversed);
      }
    }

    const movement = { transactionId: transaction.id, at };
    let ledgerEntry: WalletLedgerEntry | undefined;
    const direction = transaction.affectsBalance() ? transaction.ledgerDirectionFor(reference) : undefined;
    if (direction === LedgerDirection.Debit) {
      if (!wallet.canDebit(transaction.money)) {
        return reject(
          transaction.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds,
        );
      }
      ledgerEntry = wallet.debit(transaction.money, movement);
    } else if (direction === LedgerDirection.Credit) {
      ledgerEntry = wallet.credit(transaction.money, movement);
    }
    transaction.markProcessed(reference?.id, at, wallet.balance);
    return { pending: false, ledgerEntry };
  }

  private async isAlreadyReversed(em: EntityManager, referenceTransactionId: string): Promise<boolean> {
    const reversals = await em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return reversals > 0;
  }

  /** Lançamento, saldo/version e eventos na outbox (a transação em si já foi gravada pelo chamador). */
  private persistEffects(
    em: EntityManager,
    wallet: Wallet,
    walletRecord: WalletRecord,
    transaction: WagerTransaction,
    evaluation: Evaluation,
    ctx: EventContext,
  ): void {
    const ledgerEntry = evaluation.pending ? undefined : evaluation.ledgerEntry;
    if (ledgerEntry) {
      em.persist(ledgerEntryToRecord(ledgerEntry));
      copyWalletState(wallet, walletRecord); // saldo e version só mudam quando há lançamento
    }
    for (const event of this.eventsFor(wallet, transaction, ledgerEntry, ctx)) {
      em.persist(outboxToRecord(OutboxMessage.enqueue(event)));
    }
  }

  private eventsFor(
    wallet: Wallet,
    transaction: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    ctx: EventContext,
  ): IntegrationEvent<unknown>[] {
    switch (transaction.status) {
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, ctx)];
      case WagerTransactionStatus.PendingReference:
        return [WagerTransactionPendingReference.from(transaction, ctx)];
      case WagerTransactionStatus.Processed:
        return entry
          ? [WagerTransactionProcessed.from(transaction, ctx), WalletBalanceChanged.from(wallet, entry, ctx)]
          : [WagerTransactionProcessed.from(transaction, ctx)];
      default:
        return [];
    }
  }

  /** Mesmo hash → resultado original/atual (replay). Hash diferente → 409, nunca replay. */
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
         reference_transaction_id, status, failure_code, result_balance, created_at, processed_at,
         reference_attempts, next_reference_attempt_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        r.id, r.providerId, r.externalTransactionId, r.idempotencyKey, r.payloadHash, r.walletId, r.playerId,
        r.roundId, r.gameId, r.kind, r.amount, r.currency, r.referenceExternalTransactionId,
        r.referenceTransactionId, r.status, r.failureCode, r.resultBalance, r.createdAt, r.processedAt,
        r.referenceAttempts, r.nextReferenceAttemptAt,
      ],
      'all',
      em.getTransactionContext(),
    );
    return rows.length === 1;
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
