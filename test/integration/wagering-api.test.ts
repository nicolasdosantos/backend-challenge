import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '../../src/domain/id';
import { computePayloadHash } from '../../src/wagering/payload-hash';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { openWallet, wagerCommand, type TestWallet } from '../support/wagering';

let t: TestApp;
const touched: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
});

async function wallet(amount = '100.00'): Promise<TestWallet> {
  const w = await openWallet(t, amount);
  touched.push(w.id);
  return w;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function getJson(path: string) {
  const response = await fetch(`${t.baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function expectErrorBody(body: Record<string, unknown>, code: string, retryable = false) {
  expect(body).toEqual({ code, message: expect.any(String), retryable });
}

describe('POST /wagering/transactions — sucesso e replays', () => {
  test('200 PROCESSED e replay 200 com idempotentReplay=true e o mesmo resultado', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: brl('25.00') });

    const first = await submitTransaction(t.baseUrl, command);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('75.00'),
      idempotentReplay: false,
    });

    const replay = await submitTransaction(t.baseUrl, command);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('replay depois que o saldo mudou devolve o saldo DA ÉPOCA, não o atual (#7)', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('30.00') });
    expect((await submitTransaction(t.baseUrl, bet)).body.balance).toEqual(brl('70.00'));
    await submitTransaction(t.baseUrl, wagerCommand(w, { kind: 'WIN', money: brl('50.00') }));

    const replay = await submitTransaction(t.baseUrl, bet);
    expect(replay.body).toMatchObject({ balance: brl('70.00'), idempotentReplay: true });
    expect((await getJson(`/wallets/${w.id}`)).body.balance).toEqual(brl('120.00'));
  });

  test('422 rejeição de negócio; replay devolve 422 com o mesmo failureCode e idempotentReplay=true (#6)', async () => {
    const w = await wallet('10.00');
    const command = wagerCommand(w, { money: brl('50.00') });

    const first = await submitTransaction(t.baseUrl, command);
    expect(first.status).toBe(422);
    expect(first.body).toEqual({
      code: 'BUSINESS_RULE_REJECTED',
      message: expect.any(String),
      retryable: false,
      failureCode: 'INSUFFICIENT_FUNDS',
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: brl('10.00'),
      idempotentReplay: false,
    });

    const replay = await submitTransaction(t.baseUrl, command);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('202 para transação em PENDING_REFERENCE (estado atual, inserida direto no banco de teste)', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { kind: 'REFUND', referenceExternalTransactionId: `bet-${newId()}`, money: brl('25.00') });
    const id = newId();
    await t.orm.em.getConnection().execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         status, created_at, next_reference_attempt_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REFUND', '25.00', 'BRL', ?, 'PENDING_REFERENCE', now(), now() + interval '1 hour')`,
      [
        id, command.providerId, command.externalTransactionId, command.idempotencyKey, computePayloadHash(command),
        w.id, w.playerId, command.roundId, command.gameId, command.referenceExternalTransactionId,
      ],
    );

    const response = await submitTransaction(t.baseUrl, command);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ transactionId: id, status: 'PENDING_REFERENCE', balance: brl('100.00'), idempotentReplay: true });
  });
});

describe('POST /wagering/transactions — erros (corpo { code, message, retryable })', () => {
  test.each([
    ['sem header Idempotency-Key', { 'idempotency-key': '' }, {}],
    ['chave no corpo diferente do header', {}, { idempotencyKey: 'outra-chave' }],
    ['amount com 3 casas', {}, { money: brl('1.001') }],
    ['amount como number', {}, { money: { amount: 10, currency: 'BRL' } }],
    ['OPENING pela API', {}, { kind: 'OPENING' }],
    ['BET com referência', {}, { referenceExternalTransactionId: 'x' }],
  ])('400 INVALID_PAYLOAD: %s', async (_label, headers, bodyOverride) => {
    const w = await wallet();
    const command = wagerCommand(w);
    const { idempotencyKey, correlationId: _c, ...body } = command;
    const response = await fetch(`${t.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, ...headers },
      body: JSON.stringify({ ...body, ...bodyOverride }),
    });
    expect(response.status).toBe(400);
    expectErrorBody((await response.json()) as Record<string, unknown>, 'INVALID_PAYLOAD');
    expect(await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [w.id])).toBe(0);
  });

  test('400 INVALID_PAYLOAD: JSON malformado', async () => {
    const response = await fetch(`${t.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{"providerId":',
    });
    expect(response.status).toBe(400);
    expectErrorBody((await response.json()) as Record<string, unknown>, 'INVALID_PAYLOAD');
  });

  test('404 WALLET_NOT_FOUND', async () => {
    const w = await wallet();
    const response = await submitTransaction(t.baseUrl, wagerCommand(w, { walletId: newId() }));
    expect(response.status).toBe(404);
    expectErrorBody(response.body, 'WALLET_NOT_FOUND');
  });

  test('409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const w = await wallet();
    const command = wagerCommand(w, { money: brl('10.00') });
    await submitTransaction(t.baseUrl, command);
    const conflict = await submitTransaction(t.baseUrl, { ...command, money: brl('11.00') });
    expect(conflict.status).toBe(409);
    expectErrorBody(conflict.body, 'IDEMPOTENCY_KEY_CONFLICT');
  });

  test('409 DUPLICATE_EXTERNAL_TRANSACTION', async () => {
    const w = await wallet();
    const command = wagerCommand(w, { money: brl('10.00') });
    await submitTransaction(t.baseUrl, command);
    const duplicate = await submitTransaction(t.baseUrl, { ...command, idempotencyKey: `other-${newId()}` });
    expect(duplicate.status).toBe(409);
    expectErrorBody(duplicate.body, 'DUPLICATE_EXTERNAL_TRANSACTION');
  });

  test('202 PENDING_REFERENCE quando a referência ainda não chegou', async () => {
    const w = await wallet();
    const response = await submitTransaction(
      t.baseUrl,
      wagerCommand(w, { kind: 'REFUND', referenceExternalTransactionId: `bet-${newId()}`, money: brl('10.00') }),
    );
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00'), idempotentReplay: false });
  });
});

describe('consultas', () => {
  test('GET /wallets/:id, /wagering/transactions/:id e /providers/:providerId/wagering/transactions/:externalId', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: brl('25.00') });
    const { body } = await submitTransaction(t.baseUrl, command);

    expect((await getJson(`/wallets/${w.id}`)).body).toEqual({ id: w.id, playerId: w.playerId, balance: brl('75.00'), version: 2 });

    const byId = await getJson(`/wagering/transactions/${body.transactionId as string}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      transactionId: body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: command.externalTransactionId,
      walletId: w.id,
      playerId: w.playerId,
      roundId: command.roundId,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
      status: 'PROCESSED',
      balanceAfter: brl('75.00'),
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });

    const byExternal = await getJson(`/providers/provider-a/wagering/transactions/${command.externalTransactionId}`);
    expect(byExternal.body).toEqual(byId.body);
  });

  test.each([
    ['/wallets/00000000-0000-7000-8000-000000000000', 'WALLET_NOT_FOUND'],
    ['/wallets/nao-e-uuid', 'WALLET_NOT_FOUND'],
    ['/wallets/00000000-0000-7000-8000-000000000000/ledger', 'WALLET_NOT_FOUND'],
    ['/wagering/transactions/00000000-0000-7000-8000-000000000000', 'TRANSACTION_NOT_FOUND'],
    ['/providers/provider-a/wagering/transactions/nao-existe', 'TRANSACTION_NOT_FOUND'],
    ['/rota-inexistente', 'NOT_FOUND'],
  ])('404 em GET %s', async (path, code) => {
    const { status, body } = await getJson(path);
    expect(status).toBe(404);
    expectErrorBody(body, code);
  });

  test('POST /wallets/:id/reconciliation segue o contrato do enunciado', async () => {
    const w = await wallet('100.00');
    const response = await fetch(`${t.baseUrl}/wallets/${w.id}/reconciliation`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: w.id,
      storedBalance: brl('100.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 1,
    });
  });

  test('409 WALLET_ALREADY_EXISTS também segue o corpo de erro único', async () => {
    const w = await wallet();
    const response = await fetch(`${t.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: w.playerId, initialBalance: brl('1.00') }),
    });
    expect(response.status).toBe(409);
    expectErrorBody((await response.json()) as Record<string, unknown>, 'WALLET_ALREADY_EXISTS');
  });
});
