import { LockMode } from '@mikro-orm/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletRecord } from '../../src/database/records';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { ProcessWagerTransaction, type WagerTransactionResult } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { openWallet, wagerCommand } from '../support/wagering';

/**
 * Paralelismo real: as operações são disparadas juntas com Promise.all e cada uma usa
 * seu próprio EntityManager e sua própria conexão (pool de 60), no PostgreSQL real.
 */
let t: TestApp;
let useCase: ProcessWagerTransaction;
const touched: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
  useCase = t.app.get(ProcessWagerTransaction);
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const byStatus = (results: WagerTransactionResult[], status: string) => results.filter((r) => r.status === status);

async function walletBalance(walletId: string): Promise<string | undefined> {
  const [row] = await t.orm.em
    .getConnection()
    .execute<{ balance: string }[]>(`select balance::text as balance from wallets where id = ?`, [walletId]);
  return row?.balance;
}

function debitCount(walletId: string) {
  return countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);
}

describe('concorrência na mesma wallet', () => {
  test('cenário obrigatório §8: saldo 100, duas BET de 80 simultâneas', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const commands = [wagerCommand(w, { money: brl('80.00') }), wagerCommand(w, { money: brl('80.00') })];

    const results = await Promise.all(commands.map((c) => useCase.execute(c)));

    expect(byStatus(results, 'PROCESSED')).toHaveLength(1);
    expect(byStatus(results, 'REJECTED')).toHaveLength(1);
    expect(byStatus(results, 'REJECTED')[0]?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await walletBalance(w.id)).toBe('20.00');
    expect(await debitCount(w.id)).toBe(1);
    const rejectedEvents = () =>
      countRows(t.orm, `select 1 from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'`, [w.id]);
    expect(await rejectedEvents()).toBe(1);

    // Reenviar as duas (inclusive em paralelo) não muda nada.
    const outboxBefore = await countRows(t.orm, `select 1 from outbox_messages where aggregate_id = ?`, [w.id]);
    const retries = await Promise.all(commands.map((c) => useCase.execute(c)));
    expect(retries.every((r) => r.idempotentReplay)).toBe(true);
    expect(retries.map((r) => r.transactionId).sort()).toEqual(results.map((r) => r.transactionId).sort());
    expect(await walletBalance(w.id)).toBe('20.00');
    expect(await debitCount(w.id)).toBe(1);
    expect(await rejectedEvents()).toBe(1);
    expect(await countRows(t.orm, `select 1 from outbox_messages where aggregate_id = ?`, [w.id])).toBe(outboxBefore);
  });

  test('50 BETs de 1.00 simultâneas com saldo 30.00: 30 processadas, 20 rejeitadas, saldo 0.00', async () => {
    const w = await openWallet(t, '30.00');
    touched.push(w.id);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCase.execute(wagerCommand(w, { money: brl('1.00') }))),
    );

    expect(byStatus(results, 'PROCESSED')).toHaveLength(30);
    expect(byStatus(results, 'REJECTED')).toHaveLength(20);
    expect(byStatus(results, 'REJECTED').every((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await walletBalance(w.id)).toBe('0.00');
    expect(await debitCount(w.id)).toBe(30);
    const [version] = await t.orm.em.getConnection().execute(`select version from wallets where id = ?`, [w.id]);
    expect(version).toEqual({ version: 31 }); // 1 da abertura + 30 débitos
  });
});

describe('concorrência entre wallets distintas', () => {
  test('lock é por wallet: com a wallet A travada, uma BET na wallet B termina e a da A continua esperando', async () => {
    const a = await openWallet(t, '100.00');
    const b = await openWallet(t, '100.00');
    touched.push(a.id, b.id);
    const conflictsBefore = (await t.metrics.lockConflicts.get()).values[0]?.value ?? 0;

    // Transação aberta segurando o FOR UPDATE da wallet A até liberarmos o "portão".
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lockAcquired!: () => void;
    const locked = new Promise<void>((resolve) => (lockAcquired = resolve));
    const holder = t.orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletRecord, { id: a.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      lockAcquired();
      await gate;
    });
    await locked;

    let betOnAFinished = false;
    const betOnA = useCase.execute(wagerCommand(a, { money: brl('10.00') })).then((r) => {
      betOnAFinished = true;
      return r;
    });

    const betOnB = await useCase.execute(wagerCommand(b, { money: brl('10.00') }));
    expect(betOnB.status).toBe(WagerTransactionStatus.Processed);
    expect(await walletBalance(b.id)).toBe('90.00');

    // A BET da wallet A só pode estar bloqueada pelo lock (que ainda está preso).
    expect(betOnAFinished).toBe(false);
    expect(await walletBalance(a.id)).toBe('100.00');

    release();
    await holder;
    expect((await betOnA).status).toBe(WagerTransactionStatus.Processed);
    expect(await walletBalance(a.id)).toBe('90.00');
    expect((await t.metrics.lockConflicts.get()).values[0]?.value).toBeGreaterThan(conflictsBefore);
  });

  test('20 wallets com BETs em paralelo: todas corretas', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(t, '50.00')));
    touched.push(...wallets.map((w) => w.id));

    const results = await Promise.all(
      wallets.flatMap((w) => [
        useCase.execute(wagerCommand(w, { money: brl('20.00') })),
        useCase.execute(wagerCommand(w, { money: brl('20.00') })),
        useCase.execute(wagerCommand(w, { money: brl('20.00') })),
      ]),
    );

    expect(byStatus(results, 'PROCESSED')).toHaveLength(40); // 2 por wallet
    expect(byStatus(results, 'REJECTED')).toHaveLength(20); // 1 por wallet
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('10.00');
    }
  });
});
