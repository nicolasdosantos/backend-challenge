import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestOrm } from '../support/database';

const TABLES = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];

describe('migrations (PostgreSQL real)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.migrator.up();
    await orm.close();
  });

  async function existingTables(): Promise<string[]> {
    const rows = await orm.em
      .getConnection()
      .execute<{ table_name: string }[]>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_name in (?)`,
        [TABLES],
      );
    return rows.map((r) => r.table_name).sort();
  }

  async function ledgerTriggers(): Promise<string[]> {
    const rows = await orm.em
      .getConnection()
      .execute<{ tgname: string }[]>(
        `select tgname from pg_trigger where tgrelid = to_regclass('wallet_ledger_entries') and not tgisinternal`,
      );
    return rows.map((r) => r.tgname).sort();
  }

  test('up cria todas as tabelas e os triggers do ledger; down remove tudo; up recria', async () => {
    expect(await existingTables()).toEqual([...TABLES].sort());
    expect(await ledgerTriggers()).toEqual(['wallet_ledger_entries_no_truncate', 'wallet_ledger_entries_no_update_delete']);

    await orm.migrator.down({ to: 0 });
    expect(await existingTables()).toEqual([]);
    const [fn] = await orm.em
      .getConnection()
      .execute<{ count: string }[]>(`select count(*)::text as count from pg_proc where proname = 'wallet_ledger_entries_append_only'`);
    expect(fn?.count).toBe('0');

    await orm.migrator.up();
    expect(await existingTables()).toEqual([...TABLES].sort());
    expect(await ledgerTriggers()).toHaveLength(2);
  });
});
