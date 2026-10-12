// Eventos de integração publicados na fila wallet-events.fifo. Cada evento é uma subclasse com eventType
// e version fixos no tipo; `data` leva dinheiro como MoneyProps (string decimal), nunca a instância de Money.

import { newId } from './id';
import type { MoneyProps } from './money';
import type { FailureCode } from './failure-code';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Contexto de rastreio propagado da requisição/mensagem de origem. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  at: Date;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /** Todos os eventos usam a wallet como aggregateId: na fila FIFO, a ordem é garantida por wallet. */
  protected static baseProps<T>(walletId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
    return {
      eventId: newId(),
      aggregateId: walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.at,
      data,
    };
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

interface TransactionData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionData(tx: WagerTransaction): TransactionData {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.resultBalance) {
      throw new Error('Processed transaction must have a result balance');
    }
    return new WagerTransactionProcessed(
      IntegrationEvent.baseProps(tx.walletId, ctx, {
        ...transactionData(tx),
        ...(tx.referenceTransactionId !== undefined && { referenceTransactionId: tx.referenceTransactionId }),
        balanceAfter: tx.resultBalance.toJSON(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error('Rejected transaction must have a failure code');
    }
    return new WagerTransactionRejected(
      IntegrationEvent.baseProps(tx.walletId, ctx, { ...transactionData(tx), failureCode: tx.failureCode }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.referenceExternalTransactionId === undefined) {
      throw new Error('Pending reference transaction must have a reference');
    }
    return new WagerTransactionPendingReference(
      IntegrationEvent.baseProps(tx.walletId, ctx, {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.baseProps(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
