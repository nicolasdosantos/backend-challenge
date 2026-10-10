import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InvalidRequestError, WalletNotFoundError } from '../application-errors';
import { ledgerEntryToDomain, walletToDomain } from '../database/mappers';
import { LedgerEntryRecord, WalletRecord } from '../database/records';
import { isUuid } from '../domain/id';
import type { MoneyProps } from '../domain/money';
import type { LedgerDirection } from '../domain/wallet-ledger-entry';
import type { WalletView } from './create-wallet';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string | Date; // consulta crua: o driver devolve timestamptz como string
  seq: string;
}

function toLedgerRecord(row: LedgerRow): LedgerEntryRecord {
  const record = new LedgerEntryRecord();
  record.id = row.id;
  record.walletId = row.wallet_id;
  record.transactionId = row.transaction_id;
  record.direction = row.direction;
  record.amount = row.amount;
  record.currency = row.currency;
  record.balanceBefore = row.balance_before;
  record.balanceAfter = row.balance_after;
  record.createdAt = new Date(row.created_at);
  return record;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 100;

/**
 * Posição do último lançamento já entregue. A ordem é a coluna `seq` (identity): lançamentos da
 * mesma wallet são inseridos sob o lock da wallet, então a ordem do seq é a ordem de commit,
 * sem depender do relógio de nenhuma instância.
 */
interface LedgerCursor {
  seq: string;
}

/** Cursor opaco para o cliente: JSON em base64url. O cliente só devolve o que recebeu. */
export function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(raw: string): LedgerCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<LedgerCursor>;
    if (typeof parsed.seq === 'string' && /^[1-9]\d{0,18}$/.test(parsed.seq)) {
      return { seq: parsed.seq };
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidRequestError('Invalid cursor');
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LEDGER_LIMIT;
  }
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
    throw new InvalidRequestError(`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`);
  }
  return limit;
}

@Injectable()
export class WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = walletToDomain(await this.findWallet(walletId));
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  /**
   * Keyset pagination em `seq`, do lançamento mais antigo para o mais novo. Lançamentos novos
   * recebem seq maior, então páginas seguintes não repetem nem pulam itens.
   * SQL explícito porque `seq` é gerado pelo banco e não faz parte do registro do ORM.
   */
  async getLedgerPage(walletId: string, rawCursor: string | undefined, rawLimit: string | undefined): Promise<LedgerPage> {
    const limit = parseLimit(rawLimit);
    const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
    await this.findWallet(walletId);

    const rows = await this.orm.em.getConnection().execute<LedgerRow[]>(
      `select id, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after,
              created_at, seq::text as seq
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq
        limit ?`,
      [walletId, cursor?.seq ?? '0', limit + 1],
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => {
        const entry = ledgerEntryToDomain(toLedgerRecord(row));
        return {
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        };
      }),
      nextCursor: rows.length > limit && last ? encodeCursor({ seq: last.seq }) : null,
    };
  }

  private async findWallet(walletId: string): Promise<WalletRecord> {
    const wallet = isUuid(walletId) ? await this.orm.em.fork().findOne(WalletRecord, { id: walletId }) : null;
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}
