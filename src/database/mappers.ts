import type { FailureCode } from '../domain/failure-code';
import type { InboxMessage } from '../domain/inbox-message';
import { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/** Converte registro ↔ domínio. Na leitura sempre via `rehydrate` (não revalida transições). */

const money = (amount: string, currency: string) => Money.from({ amount, currency });

// ---- Wallet

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  const record = new WalletRecord();
  record.id = wallet.id;
  record.playerId = wallet.playerId;
  record.currency = wallet.currency;
  record.createdAt = wallet.createdAt;
  return copyWalletState(wallet, record);
}

/** Copia o estado mutável para o registro gerenciado; se nada mudou, o MikroORM não emite UPDATE. */
export function copyWalletState(wallet: Wallet, record: WalletRecord): WalletRecord {
  record.balance = wallet.balance.amount;
  record.version = wallet.version;
  record.updatedAt = wallet.updatedAt;
  return record;
}

// ---- WagerTransaction

/** `walletCurrency`: o saldo resultante está na moeda da wallet, que pode diferir da transação (CURRENCY_MISMATCH). */
export function transactionToDomain(record: WagerTransactionRecord, walletCurrency: string): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    resultBalance: record.resultBalance != null ? money(record.resultBalance, walletCurrency) : undefined,
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
  });
}

export function transactionToRecord(tx: WagerTransaction): WagerTransactionRecord {
  const record = new WagerTransactionRecord();
  record.id = tx.id;
  record.providerId = tx.providerId;
  record.externalTransactionId = tx.externalTransactionId;
  record.idempotencyKey = tx.idempotencyKey;
  record.payloadHash = tx.payloadHash;
  record.walletId = tx.walletId;
  record.playerId = tx.playerId;
  record.roundId = tx.roundId;
  record.gameId = tx.gameId;
  record.kind = tx.kind;
  record.amount = tx.money.amount;
  record.currency = tx.money.currency;
  record.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
  record.createdAt = tx.createdAt;
  return copyTransactionState(tx, record);
}

/** Copia o estado mutável (status e resultado) para um registro; usado também no reprocessamento. */
export function copyTransactionState(tx: WagerTransaction, record: WagerTransactionRecord): WagerTransactionRecord {
  record.referenceTransactionId = tx.referenceTransactionId ?? null;
  record.status = tx.status;
  record.failureCode = tx.failureCode ?? null;
  record.resultBalance = tx.resultBalance?.amount ?? null;
  record.processedAt = tx.processedAt ?? null;
  record.referenceAttempts = tx.referenceAttempts;
  record.nextReferenceAttemptAt = tx.nextReferenceAttemptAt ?? null;
  return record;
}

// ---- Ledger

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    at: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  const record = new LedgerEntryRecord();
  record.id = entry.id;
  record.walletId = entry.walletId;
  record.transactionId = entry.transactionId;
  record.direction = entry.direction;
  record.amount = entry.money.amount;
  record.currency = entry.money.currency;
  record.balanceBefore = entry.balanceBefore.amount;
  record.balanceAfter = entry.balanceAfter.amount;
  record.createdAt = entry.createdAt;
  return record;
}

// ---- Inbox / Outbox

export function inboxToRecord(message: InboxMessage): InboxMessageRecord {
  const record = new InboxMessageRecord();
  record.consumerName = message.consumerName;
  record.messageId = message.messageId;
  record.payloadHash = message.payloadHash;
  record.receivedAt = message.receivedAt;
  record.processedAt = message.processedAt ?? null;
  return record;
}

export function outboxToRecord(message: OutboxMessage): OutboxMessageRecord {
  const record = new OutboxMessageRecord();
  record.id = message.id;
  record.aggregateId = message.aggregateId;
  record.eventType = message.eventType;
  record.payload = { ...message.payload };
  record.occurredAt = message.occurredAt;
  record.attempts = message.attempts;
  record.nextAttemptAt = message.nextAttemptAt ?? null;
  record.publishedAt = message.publishedAt ?? null;
  return record;
}
