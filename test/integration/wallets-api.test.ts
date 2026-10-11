// POST /wallets: abertura com OPENING, lançamento e eventos na mesma transação; saldo zero; wallet
// duplicada; entradas inválidas.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '../../src/domain/id';
import { createTestApp, type TestApp } from '../support/app';
import { countRows, expectLedgerConsistent } from '../support/invariants';

let t: TestApp;
const touched: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
});

function postWallet(body: unknown) {
  return fetch(`${t.baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-test' },
    body: JSON.stringify(body),
  });
}

describe('POST /wallets', () => {
  test('cria wallet com OPENING PROCESSED + lançamento CREDIT 0 → saldo inicial + 2 eventos na outbox', async () => {
    const playerId = `player-${newId()}`;
    const response = await postWallet({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    expect(body as unknown).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    touched.push(body.id);

    const [opening] = await t.orm.em
      .getConnection()
      .execute(`select kind, status, amount::text as amount, provider_id from wager_transactions where wallet_id = ?`, [body.id]);
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00', provider_id: 'internal' });

    const [entry] = await t.orm.em
      .getConnection()
      .execute(
        `select direction, amount::text as amount, balance_before::text as before, balance_after::text as after
           from wallet_ledger_entries where wallet_id = ?`,
        [body.id],
      );
    expect(entry).toEqual({ direction: 'CREDIT', amount: '1000.00', before: '0.00', after: '1000.00' });

    const events = await t.orm.em
      .getConnection()
      .execute<{ event_type: string; correlation_id: string }[]>(
        `select event_type, payload->>'correlationId' as correlation_id from outbox_messages where aggregate_id = ? order by id`,
        [body.id],
      );
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', correlation_id: 'corr-test' },
      { event_type: 'WalletBalanceChanged', correlation_id: 'corr-test' },
    ]);
  });

  test('saldo inicial zero: wallet criada sem OPENING, sem lançamento e sem eventos', async () => {
    const response = await postWallet({ playerId: `player-${newId()}`, initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; version: number };
    expect(body.version).toBe(1);
    touched.push(body.id);

    expect(await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ?`, [body.id])).toBe(0);
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ?`, [body.id])).toBe(0);
    expect(await countRows(t.orm, `select 1 from outbox_messages where aggregate_id = ?`, [body.id])).toBe(0);
  });

  test('wallet duplicada (mesmo playerId + moeda) → 409; outra moeda é permitida', async () => {
    const playerId = `player-${newId()}`;
    const first = await postWallet({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
    touched.push(((await first.json()) as { id: string }).id);

    const duplicate = await postWallet({ playerId, initialBalance: { amount: '99.00', currency: 'BRL' } });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
    expect(await countRows(t.orm, `select 1 from wallets where player_id = ?`, [playerId])).toBe(1);

    const otherCurrency = await postWallet({ playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(otherCurrency.status).toBe(201);
    touched.push(((await otherCurrency.json()) as { id: string }).id);
  });

  test.each([
    ['sem playerId', { initialBalance: { amount: '10.00', currency: 'BRL' } }],
    ['amount negativo', { playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    ['amount como number', { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
    ['mais de 2 casas', { playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } }],
    ['moeda inválida', { playerId: 'p', initialBalance: { amount: '1.00', currency: 'real' } }],
    ['corpo vazio', {}],
  ])('payload inválido (%s) → 400 sem gravar nada', async (_label, body) => {
    const response = await postWallet(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_PAYLOAD', retryable: false });
  });
});
