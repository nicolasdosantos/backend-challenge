import type { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';

interface WalletLedgerCheck {
  id: string;
  balance: string;
  from_ledger: string;
  last_balance_after: string | null;
}

/**
 * Invariante final: para cada wallet, saldo armazenado == créditos − débitos == último balance_after.
 * Comparação de strings de numeric(20,2), sem passar por number.
 */
export async function expectLedgerConsistent(orm: MikroORM, walletIds: string[]): Promise<void> {
  expect(walletIds.length).toBeGreaterThan(0);
  const rows = await orm.em.getConnection().execute<WalletLedgerCheck[]>(
    `select w.id,
            w.balance::text as balance,
            (coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0)
              - coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0))::numeric(20,2)::text as from_ledger,
            (select l2.balance_after::text from wallet_ledger_entries l2
              where l2.wallet_id = w.id order by l2.created_at desc, l2.id desc limit 1) as last_balance_after
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id in (?)
      group by w.id`,
    [walletIds],
  );
  expect(rows).toHaveLength(walletIds.length);
  for (const row of rows) {
    expect({ wallet: row.id, fromLedger: row.from_ledger }).toEqual({ wallet: row.id, fromLedger: row.balance });
    expect({ wallet: row.id, lastBalanceAfter: row.last_balance_after ?? '0.00' }).toEqual({
      wallet: row.id,
      lastBalanceAfter: row.balance,
    });
  }
}

export async function countRows(orm: MikroORM, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await orm.em.getConnection().execute<{ count: number }[]>(`select count(*)::int as count from (${sql}) q`, params);
  return row?.count ?? 0;
}
