// Mapeamento das tabelas com EntitySchema (sem decorators), para o domínio não depender do ORM.

import { EntitySchema } from '@mikro-orm/core';

/**
 * Registros de persistência: espelham as tabelas da migration baseline, com dinheiro como
 * string (numeric(20,2) exato). O domínio não conhece estas classes; a conversão fica em mappers.ts.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'text' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'decimal', precision: 20, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  createdAt!: Date;
  processedAt?: Date | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'text' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    resultBalance: { type: 'decimal', precision: 20, scale: 2, nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2 },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'text' },
    eventType: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export const ALL_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema];
