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

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 100;

/** Posição da última entrada já entregue. Ordem estável: (created_at, id). */
interface LedgerCursor {
  createdAt: string;
  id: string;
}

/** Cursor opaco para o cliente: JSON em base64url. O cliente só devolve o que recebeu. */
export function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(raw: string): LedgerCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<LedgerCursor>;
    if (
      typeof parsed.createdAt === 'string' &&
      typeof parsed.id === 'string' &&
      isUuid(parsed.id) &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
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
   * Keyset pagination em (created_at, id), da entrada mais antiga para a mais nova.
   * Entradas novas entram no fim da ordem, então páginas seguintes não repetem nem pulam itens.
   */
  async getLedgerPage(walletId: string, rawCursor: string | undefined, rawLimit: string | undefined): Promise<LedgerPage> {
    const limit = parseLimit(rawLimit);
    const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
    await this.findWallet(walletId);

    const after = cursor && new Date(cursor.createdAt);
    const records = await this.orm.em.fork().find(
      LedgerEntryRecord,
      {
        walletId,
        ...(after && cursor && { $or: [{ createdAt: { $gt: after } }, { createdAt: after, id: { $gt: cursor.id } }] }),
      },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit: limit + 1 },
    );

    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((record) => {
        const entry = ledgerEntryToDomain(record);
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
      nextCursor:
        records.length > limit && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
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
