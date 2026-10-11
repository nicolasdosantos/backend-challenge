// Agregado WagerTransaction: uma operação do provedor (BET, WIN, LOSS, REFUND, ROLLBACK) ou a abertura
// interna da wallet (OPENING). Concentra a validação na criação, as transições de status e a checagem
// da transação referenciada.

import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import { newId } from './id';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL_STATUSES = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

/** Que tipo de transação cada kind pode referenciar. BET e OPENING não aceitam referência. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  id: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date;
}

/** Resultado da validação de uma referência já encontrada. */
export type ReferenceCheck =
  | { outcome: 'valid' }
  | { outcome: 'wait' } // referência existe mas ainda não terminou de processar
  | { outcome: 'invalid'; failureCode: FailureCode };

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Transação vinda de provedor (API ou fila). Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      if (!props[field]) {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(`Unknown kind ${String(props.kind)}`);
    }
    const hasReference = props.referenceExternalTransactionId !== undefined;
    if (hasReference && !ALLOWED_REFERENCE_KINDS[props.kind]) {
      throw new InvalidWagerTransactionError(`${props.kind} does not accept a reference`);
    }
    if (!hasReference && (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback)) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (hasReference && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError('referenceExternalTransactionId cannot be empty');
    }
    if (props.money.isZero() && props.kind !== WagerTransactionKind.Loss) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be greater than zero`);
    }
    return WagerTransaction.newPending(props);
  }

  /** Transação interna que registra o saldo inicial de uma wallet. */
  static opening(props: { walletId: string; playerId: string; money: Money }): WagerTransaction {
    const key = `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`;
    return WagerTransaction.newPending({
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: key,
      payloadHash: key,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
    });
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return WagerTransaction.rehydrate({
      ...props,
      id: newId(),
      createdAt: new Date(),
      status: WagerTransactionStatus.Pending,
    });
  }

  /** Reconstrói a partir do banco. Não revalida regras nem transições: o estado já foi aceito antes. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts ?? 0,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Instante em que a transação chegou a um estado terminal. */
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Saldo da wallet observado no fim do processamento; devolvido em replays (regra 7.7). */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  /** Quantas vezes o worker já reavaliou a referência (0 enquanto só houve a avaliação inicial). */
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  /** Próxima reavaliação agendada; só existe em PENDING_REFERENCE. */
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições
  // PENDING -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
  // PENDING_REFERENCE -> PENDING_REFERENCE (nova tentativa agendada) | PROCESSED | REJECTED | FAILED
  // PROCESSED, REJECTED e FAILED são terminais.

  /** Transação aplicada. `resultBalance` é o saldo logo depois dela, devolvido igual nos replays. */
  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** A referência ainda não existe (ou ainda não terminou): fica aguardando o worker, a partir de `nextAttemptAt`. */
  markPendingReference(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`Cannot move ${this._status} to PENDING_REFERENCE`);
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} without reference cannot wait for one`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /** A referência continua indisponível: conta a tentativa e agenda a próxima. */
  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`Cannot schedule a reference retry for a ${this._status} transaction`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /** Rejeição de negócio: guarda o motivo e o saldo (que não mudou) observado naquele momento. */
  reject(code: FailureCode, at: Date, resultBalance: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Falha inesperada que persistiu até a última tentativa do consumidor. Sem saldo resultante. */
  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** LOSS é o único kind que nunca mexe no saldo (só registra o resultado da rodada). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** REFUND e ROLLBACK desfazem outra transação; é com isso que a regra de reversão única é aplicada. */
  isReversal(): boolean {
    return this.requiresReference();
  }

  /** Mesmo hash = mesma requisição (replay). O caso de uso compara os hashes direto; aqui é a regra no domínio. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverte a direção da transação referenciada; os demais têm direção fixa. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK direction depends on the reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not produce a ledger entry');
    }
  }

  /**
   * Validação única da referência para WIN, LOSS, REFUND e ROLLBACK (regras 7.2, 7.3 e 7.5).
   * "Já revertida" (regra 7.4) não é checada aqui: depende de outras transações e é garantida pelo banco.
   */
  checkReference(reference: WagerTransaction): ReferenceCheck {
    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameContext) {
      return { outcome: 'invalid', failureCode: FailureCode.ReferenceMismatch };
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind)) {
      return { outcome: 'invalid', failureCode: FailureCode.InvalidReferenceKind };
    }
    if (reference.status === WagerTransactionStatus.Rejected || reference.status === WagerTransactionStatus.Failed) {
      return { outcome: 'invalid', failureCode: FailureCode.ReferenceNotProcessed };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: 'wait' };
    }
    // Só reversões precisam ter o mesmo valor da referência (não existe reversão parcial); WIN pode ter qualquer valor.
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return { outcome: 'invalid', failureCode: FailureCode.AmountMismatch };
    }
    return { outcome: 'valid' };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${transition}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
