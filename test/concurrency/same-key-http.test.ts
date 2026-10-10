import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { openWallet, wagerCommand } from '../support/wagering';

let t: TestApp;
const touched: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
});

describe('cenário §13 #1', () => {
  test('a mesma aposta enviada 50 vezes em paralelo por HTTP → um único débito', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const command = wagerCommand(w, { money: { amount: '10.00', currency: 'BRL' } });

    const responses = await Promise.all(Array.from({ length: 50 }, () => submitTransaction(t.baseUrl, command)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    // todos veem o saldo da época do processamento
    expect(responses.every((r) => JSON.stringify(r.body.balance) === '{"amount":"90.00","currency":"BRL"}')).toBe(true);

    expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(1);
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.id])).toBe(1);
    const [row] = await t.orm.em.getConnection().execute(`select balance::text as balance from wallets where id = ?`, [w.id]);
    expect(row).toEqual({ balance: '90.00' });
  });
});
