// Idempotência no banco: mesma chave com payload diferente (em sequência e em paralelo), mesma chave em
// wallets diferentes (que não dividem lock) e o mesmo id do provedor com outra chave.

import type { EntityManager } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdempotencyKeyConflictError } from '../../src/application-errors';
import { APP_CONFIG, type AppConfig } from '../../src/config';
import { Metrics } from '../../src/metrics/metrics';
import { ProcessWagerTransaction } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { openWallet, wagerCommand, type TestWallet } from '../support/wagering';

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

async function wallet(amount = '100.00'): Promise<TestWallet> {
  const w = await openWallet(t, amount);
  touched.push(w.id);
  return w;
}

async function walletState(walletId: string) {
  const [row] = await t.orm.em
    .getConnection()
    .execute(`select balance::text as balance, version from wallets where id = ?`, [walletId]);
  return {
    wallet: row,
    ledger: await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ?`, [walletId]),
    transactions: await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ?`, [walletId]),
    outbox: await countRows(t.orm, `select 1 from outbox_messages where aggregate_id = ?`, [walletId]),
  };
}

async function duplicates(type: string): Promise<number> {
  return (await t.metrics.duplicates.get()).values.find((v) => v.labels.type === type)?.value ?? 0;
}

describe('mesma chave com payload diferente (#3)', () => {
  test('sequencial: 409 IDEMPOTENCY_KEY_CONFLICT, sem efeito no saldo, métrica incrementada', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: brl('10.00') });
    await submitTransaction(t.baseUrl, command);
    const before = await walletState(w.id);
    const conflictsBefore = await duplicates('idempotency_key_conflict');

    const conflict = await submitTransaction(t.baseUrl, { ...command, money: brl('99.00') });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await walletState(w.id)).toEqual(before);
    expect(await duplicates('idempotency_key_conflict')).toBe(conflictsBefore + 1);
  });

  test('paralelo: A e B disputando a mesma chave → um processa, o outro recebe 409', async () => {
    const w = await wallet('100.00');
    const a = wagerCommand(w, { money: brl('10.00') });
    // Mesma wallet: o lock serializa as duas; a segunda encontra a chave da primeira com outro hash e recebe 409.
    const b = { ...a, money: brl('20.00') };

    const responses = await Promise.all([submitTransaction(t.baseUrl, a), submitTransaction(t.baseUrl, b)]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = responses.find((r) => r.status === 200);
    const debited = winner?.body.balance as { amount: string };
    expect(['90.00', '80.00']).toContain(debited.amount);
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.id])).toBe(1);
  });
});

/** Segura o commit da transação até o teste liberar: deixa a chave gravada, mas ainda invisível. */
class PausingBeforeCommit extends ProcessWagerTransaction {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  private reachedResolve!: () => void;
  readonly reachedCommit = new Promise<void>((resolve) => (this.reachedResolve = resolve));

  constructor(t: TestApp) {
    super(t.orm, t.app.get(Metrics), t.app.get<AppConfig>(APP_CONFIG));
  }

  letCommit() {
    this.release();
  }

  protected override async beforeCommit(_em: EntityManager): Promise<void> {
    this.reachedResolve();
    await this.gate;
  }
}

async function waitForInsertBlockedOnLock(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await countRows(
      t.orm,
      `select 1 from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike 'insert into wager_transactions%'`,
    );
    if (waiting > 0) return;
    await Bun.sleep(20);
  }
  throw new Error('a segunda transação nunca chegou a esperar no INSERT');
}

describe('mesma chave disputando wallets diferentes (#4)', () => {
  test('determinístico: B chega ao INSERT ON CONFLICT enquanto A não commitou → 409 sem tocar no saldo de B', async () => {
    const walletA = await wallet('100.00');
    const walletB = await wallet('100.00');
    const commandA = wagerCommand(walletA, { money: brl('30.00') });
    const commandB = { ...wagerCommand(walletB, { money: brl('30.00') }), idempotencyKey: commandA.idempotencyKey };
    const walletBBefore = await walletState(walletB.id);

    // A grava tudo (inclusive a chave) e para antes do commit.
    const pausing = new PausingBeforeCommit(t);
    const runA = pausing.execute(commandA);
    await pausing.reachedCommit;

    // B: wallet diferente (lock diferente). A busca pela chave não vê A (não commitada),
    // então B decide e tenta o INSERT, que fica esperando a transação de A.
    const runB = useCase.execute(commandB).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    await waitForInsertBlockedOnLock();

    pausing.letCommit();
    expect(String((await runA).status)).toBe('PROCESSED');
    const outcomeB = await runB;

    expect(outcomeB.error).toBeInstanceOf(IdempotencyKeyConflictError);
    // O INSERT da transação vem antes de qualquer escrita de saldo: B não alterou nada.
    expect(await walletState(walletB.id)).toEqual(walletBBefore);
    expect((await walletState(walletA.id)).wallet).toEqual({ balance: '70.00', version: 2 });
  });

  test('paralelo via HTTP (10 rodadas): um vence, o outro recebe 409, nunca dois débitos', async () => {
    for (let round = 0; round < 10; round++) {
      const walletA = await wallet('100.00');
      const walletB = await wallet('100.00');
      const commandA = wagerCommand(walletA, { money: brl('40.00') });
      const commandB = { ...wagerCommand(walletB, { money: brl('40.00') }), idempotencyKey: commandA.idempotencyKey };

      const responses = await Promise.all([submitTransaction(t.baseUrl, commandA), submitTransaction(t.baseUrl, commandB)]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)?.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      const debits = await countRows(
        t.orm,
        `select 1 from wallet_ledger_entries where wallet_id in (?, ?) and direction = 'DEBIT'`,
        [walletA.id, walletB.id],
      );
      expect(debits).toBe(1);
    }
  });
});

describe('mesmo (providerId, externalTransactionId) com outra chave (#5)', () => {
  test('409 DUPLICATE_EXTERNAL_TRANSACTION, sem efeito no saldo, métrica incrementada', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: brl('10.00') });
    await submitTransaction(t.baseUrl, command);
    const before = await walletState(w.id);
    const duplicatesBefore = await duplicates('duplicate_external_transaction');

    const duplicate = await submitTransaction(t.baseUrl, { ...command, idempotencyKey: `another-key-${command.externalTransactionId}` });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_EXTERNAL_TRANSACTION');
    expect(await walletState(w.id)).toEqual(before);
    expect(await duplicates('duplicate_external_transaction')).toBe(duplicatesBefore + 1);
  });
});
