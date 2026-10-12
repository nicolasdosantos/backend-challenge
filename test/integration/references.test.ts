// Referências: operações que chegam antes da referenciada (PENDING_REFERENCE + worker), o efeito de cada
// reversão, as validações da referência e a regra de uma reversão por transação.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '../../src/domain/id';
import { PendingReferenceWorker } from '../../src/wagering/pending-reference.worker';
import { ProcessWagerTransaction, type ProcessWagerTransactionCommand } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { openWallet, referencing, wagerCommand, type TestWallet } from '../support/wagering';
import { runWorkerUntilSettled } from '../support/worker';

let t: TestApp;
let useCase: ProcessWagerTransaction;
let worker: PendingReferenceWorker;
const touched: string[] = [];

beforeAll(async () => {
  t = await createTestApp(); // loop do worker desligado; backoff de teste 20ms, até 3 tentativas
  useCase = t.app.get(ProcessWagerTransaction);
  worker = t.app.get(PendingReferenceWorker);
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function wallet(amount = '100.00', currency = 'BRL'): Promise<TestWallet> {
  const w = await openWallet(t, amount, currency);
  touched.push(w.id);
  return w;
}

async function balance(walletId: string): Promise<string | undefined> {
  const [row] = await t.orm.em
    .getConnection()
    .execute<{ balance: string }[]>(`select balance::text as balance from wallets where id = ?`, [walletId]);
  return row?.balance;
}

async function stored(transactionId: string) {
  const [row] = await t.orm.em.getConnection().execute<
    { status: string; failure_code: string | null; reference_transaction_id: string | null }[]
  >(`select status, failure_code, reference_transaction_id from wager_transactions where id = ?`, [transactionId]);
  return row;
}

async function ledgerOf(transactionId: string) {
  return t.orm.em
    .getConnection()
    .execute<{ direction: string; amount: string }[]>(
      `select direction, amount::text as amount from wallet_ledger_entries where transaction_id = ?`,
      [transactionId],
    );
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await t.orm.em
    .getConnection()
    .execute<{ event_type: string }[]>(
      `select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by occurred_at, id`,
      [transactionId],
    );
  return rows.map((r) => r.event_type);
}

/** Executa o caso de uso e devolve o status como string, para comparar direto com os valores do contrato. */
const run = async (command: ProcessWagerTransactionCommand) => {
  const result = await useCase.execute(command);
  return { ...result, status: String(result.status) };
};

describe('referência fora de ordem (§13 #7)', () => {
  test('REFUND antes da BET: 202 PENDING_REFERENCE; a BET chega; o worker credita uma vez (#1 e #11)', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('25.00') });
    const refund = referencing(bet, 'REFUND');

    const pending = await submitTransaction(t.baseUrl, refund);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00'), idempotentReplay: false });
    const refundId = pending.body.transactionId as string;

    // Replay enquanto pendente: estado atual (#11).
    const replayPending = await submitTransaction(t.baseUrl, refund);
    expect(replayPending.status).toBe(202);
    expect(replayPending.body).toMatchObject({ transactionId: refundId, status: 'PENDING_REFERENCE', idempotentReplay: true });

    const betResult = await run(bet);
    expect(betResult).toMatchObject({ status: 'PROCESSED', balance: brl('75.00') });

    await runWorkerUntilSettled(t, worker, [refundId]);

    expect(await stored(refundId)).toEqual({ status: 'PROCESSED', failure_code: null, reference_transaction_id: betResult.transactionId });
    expect(await ledgerOf(refundId)).toEqual([{ direction: 'CREDIT', amount: '25.00' }]);
    expect(await balance(w.id)).toBe('100.00');
    expect(await eventsOf(refundId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);

    // Replay depois de resolvida: PROCESSED, 200, com o saldo do momento em que foi aplicada (#11).
    const replayDone = await submitTransaction(t.baseUrl, refund);
    expect(replayDone.status).toBe(200);
    expect(replayDone.body).toEqual({ transactionId: refundId, status: 'PROCESSED', balance: brl('100.00'), idempotentReplay: true });

    // Mais ciclos não reaplicam nada.
    await worker.processDue();
    expect(await ledgerOf(refundId)).toHaveLength(1);
  });

  test('corrente ROLLBACK → REFUND → BET chegando ao contrário resolve na ordem certa (#2)', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('25.00') });
    const refund = referencing(bet, 'REFUND');
    const rollbackOfRefund = referencing(refund, 'ROLLBACK');

    const rollbackResult = await run(rollbackOfRefund);
    const refundResult = await run(refund);
    expect([rollbackResult.status, refundResult.status]).toEqual(['PENDING_REFERENCE', 'PENDING_REFERENCE']);
    const betResult = await run(bet);
    expect(betResult.balance).toEqual(brl('75.00'));

    await runWorkerUntilSettled(t, worker, [rollbackResult.transactionId, refundResult.transactionId]);

    expect(await stored(refundResult.transactionId)).toMatchObject({ status: 'PROCESSED', reference_transaction_id: betResult.transactionId });
    expect(await stored(rollbackResult.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: refundResult.transactionId,
    });
    expect(await ledgerOf(refundResult.transactionId)).toEqual([{ direction: 'CREDIT', amount: '25.00' }]);
    expect(await ledgerOf(rollbackResult.transactionId)).toEqual([{ direction: 'DEBIT', amount: '25.00' }]);
    expect(await balance(w.id)).toBe('75.00');
  });

  test('referência que nunca chega: REJECTED REFERENCE_NOT_FOUND + evento Rejected, sem lançamento (#3)', async () => {
    const w = await wallet('100.00');
    const refund = referencing(wagerCommand(w, { money: brl('25.00') }), 'REFUND');
    const result = await run(refund);
    expect(result.status).toBe('PENDING_REFERENCE');

    await runWorkerUntilSettled(t, worker, [result.transactionId]);

    // 3 tentativas no teste: as 2 primeiras reagendam (reference_attempts = 2), a 3ª rejeita
    const [attempts] = await t.orm.em.getConnection().execute(`select reference_attempts from wager_transactions where id = ?`, [result.transactionId]);
    expect(attempts).toEqual({ reference_attempts: 2 });
    expect(await stored(result.transactionId)).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_transaction_id: null });
    expect(await ledgerOf(result.transactionId)).toEqual([]);
    expect(await eventsOf(result.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await balance(w.id)).toBe('100.00');
  });
});

describe('efeito de cada reversão (#5)', () => {
  test('ROLLBACK de BET credita; ROLLBACK de WIN debita; ROLLBACK de REFUND debita', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('30.00') });
    await run(bet); // 70
    const rollbackBet = await run(referencing(bet, 'ROLLBACK'));
    expect(rollbackBet).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(await ledgerOf(rollbackBet.transactionId)).toEqual([{ direction: 'CREDIT', amount: '30.00' }]);

    const win = wagerCommand(w, { kind: 'WIN', money: brl('40.00') });
    await run(win); // 140
    const rollbackWin = await run(referencing(win, 'ROLLBACK'));
    expect(rollbackWin).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(await ledgerOf(rollbackWin.transactionId)).toEqual([{ direction: 'DEBIT', amount: '40.00' }]);

    const bet2 = wagerCommand(w, { money: brl('20.00') });
    await run(bet2); // 80
    const refund = referencing(bet2, 'REFUND');
    expect((await run(refund)).balance).toEqual(brl('100.00'));
    const rollbackRefund = await run(referencing(refund, 'ROLLBACK'));
    expect(rollbackRefund).toMatchObject({ status: 'PROCESSED', balance: brl('80.00') });
    expect(await ledgerOf(rollbackRefund.transactionId)).toEqual([{ direction: 'DEBIT', amount: '20.00' }]);
  });

  test('regra estrita: segunda reversão da mesma BET → REJECTED ALREADY_REVERSED com commit, sem crédito', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('10.00') });
    await run(bet);
    expect((await run(referencing(bet, 'REFUND'))).status).toBe('PROCESSED');
    const second = await run(referencing(bet, 'ROLLBACK'));
    expect(second).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED', balance: brl('100.00') });
    expect(await ledgerOf(second.transactionId)).toEqual([]);
    expect(await eventsOf(second.transactionId)).toEqual(['WagerTransactionRejected']);
  });
});

describe('validação da referência (#6, #8)', () => {
  test.each([
    ['rodada diferente', (bet: ProcessWagerTransactionCommand) => referencing(bet, 'REFUND', { roundId: 'other-round' }), 'REFERENCE_MISMATCH'],
    ['valor diferente', (bet: ProcessWagerTransactionCommand) => referencing(bet, 'REFUND', { money: brl('9.99') }), 'AMOUNT_MISMATCH'],
    ['player diferente do dono da wallet', (bet: ProcessWagerTransactionCommand) => referencing(bet, 'REFUND', { playerId: 'someone-else' }), 'PLAYER_MISMATCH'],
    [
      'moeda diferente da wallet',
      (bet: ProcessWagerTransactionCommand) => referencing(bet, 'REFUND', { money: { amount: '10.00', currency: 'USD' } }),
      'CURRENCY_MISMATCH',
    ],
  ])('%s → REJECTED com o failureCode de mismatch', async (_label, build, failureCode) => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('10.00') });
    await run(bet);
    const result = await run(build(bet));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode });
    expect(await ledgerOf(result.transactionId)).toEqual([]);
    expect(await balance(w.id)).toBe('90.00');
  });

  test('referência em outra wallet (outro player, outra moeda) → REJECTED REFERENCE_MISMATCH', async () => {
    const brlWallet = await wallet('100.00', 'BRL');
    const usdWallet = await openWallet(t, '100.00', 'USD');
    touched.push(usdWallet.id);
    const bet = wagerCommand(brlWallet, { money: brl('10.00') });
    await run(bet);
    const refundInOtherWallet = {
      ...wagerCommand(usdWallet, { kind: 'REFUND', roundId: bet.roundId, money: { amount: '10.00', currency: 'USD' } }),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    expect(await run(refundInOtherWallet)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
  });

  test('referência de outro provider não é encontrada → PENDING_REFERENCE', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { providerId: 'provider-b', money: brl('10.00') });
    await run(bet);
    const refundFromProviderA = referencing(bet, 'REFUND', { providerId: 'provider-a' });
    expect((await run(refundFromProviderA)).status).toBe('PENDING_REFERENCE');
  });

  test('REFUND de WIN → REJECTED INVALID_REFERENCE_KIND', async () => {
    const w = await wallet('100.00');
    const win = wagerCommand(w, { kind: 'WIN', money: brl('10.00') });
    await run(win);
    expect(await run(referencing(win, 'REFUND'))).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
  });

  test('reversão apontando para BET REJECTED → REJECTED REFERENCE_NOT_PROCESSED (#8)', async () => {
    const w = await wallet('10.00');
    const bet = wagerCommand(w, { money: brl('500.00') });
    expect((await run(bet)).status).toBe('REJECTED');
    const refund = await run(referencing(bet, 'REFUND'));
    expect(refund).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
    expect(await balance(w.id)).toBe('10.00');
  });
});

describe('saldo insuficiente para reverter (#7)', () => {
  test('ROLLBACK de WIN com o saldo já gasto → REJECTED REVERSAL_INSUFFICIENT_FUNDS, saldo intacto, sem lançamento', async () => {
    const w = await wallet('10.00');
    const win = wagerCommand(w, { kind: 'WIN', money: brl('50.00') });
    await run(win); // 60
    await run(wagerCommand(w, { money: brl('55.00') })); // 5
    const rollback = await run(referencing(win, 'ROLLBACK'));
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: brl('5.00') });
    expect(await ledgerOf(rollback.transactionId)).toEqual([]);
    expect(await balance(w.id)).toBe('5.00');
  });
});

describe('WIN e LOSS com referência (#10)', () => {
  test('WIN com referência válida credita e grava a referência; LOSS com referência não mexe no saldo', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('10.00') });
    const betResult = await run(bet);
    const win = await run(referencing(bet, 'WIN', { money: brl('35.00') })); // WIN pode ter outro valor
    expect(win).toMatchObject({ status: 'PROCESSED', balance: brl('125.00') });
    expect((await stored(win.transactionId))?.reference_transaction_id).toBe(betResult.transactionId);

    const loss = await run(referencing(bet, 'LOSS', { money: brl('0.00') }));
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: brl('125.00') });
    expect((await stored(loss.transactionId))?.reference_transaction_id).toBe(betResult.transactionId);
    expect(await ledgerOf(loss.transactionId)).toEqual([]);
  });

  test('WIN referenciando algo que não é BET → INVALID_REFERENCE_KIND; BET com referência → 400', async () => {
    const w = await wallet('100.00');
    const win = wagerCommand(w, { kind: 'WIN', money: brl('10.00') });
    await run(win);
    expect(await run(referencing(win, 'WIN'))).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });

    const betWithReference = await submitTransaction(t.baseUrl, { ...wagerCommand(w), referenceExternalTransactionId: `x-${newId()}` });
    expect(betWithReference.status).toBe(400);
  });
});

describe('loop agendado do worker', () => {
  test('com o loop ligado, a REFUND pendente é resolvida sozinha e o shutdown para o loop', async () => {
    const auto = await createTestApp({ pendingReference: { workerEnabled: true, pollIntervalMs: 30, baseDelayMs: 20 } });
    try {
      const w = await openWallet(auto, '100.00');
      touched.push(w.id);
      const bet = wagerCommand(w, { money: brl('25.00') });
      const refund = await auto.app.get(ProcessWagerTransaction).execute(referencing(bet, 'REFUND'));
      await auto.app.get(ProcessWagerTransaction).execute(bet);

      for (let i = 0; i < 100 && (await stored(refund.transactionId))?.status === 'PENDING_REFERENCE'; i++) {
        await Bun.sleep(30);
      }
      expect((await stored(refund.transactionId))?.status).toBe('PROCESSED');
      expect(await balance(w.id)).toBe('100.00');
      expect((await auto.metrics.pendingReferenceRetries.get()).values.some((v) => v.labels.outcome === 'processed')).toBe(true);
    } finally {
      await auto.close(); // onModuleDestroy espera o ciclo em andamento
    }
  });
});
