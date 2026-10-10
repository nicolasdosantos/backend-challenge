import type { EntityManager } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletNotFoundError } from '../../src/application-errors';
import { InvalidMoneyError, InvalidWagerTransactionError } from '../../src/domain/errors';
import { newId } from '../../src/domain/id';
import { APP_CONFIG, type AppConfig } from '../../src/config';
import { Metrics } from '../../src/metrics/metrics';
import { ProcessWagerTransaction } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
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

async function wallet(amount = '100.00'): Promise<TestWallet> {
  const w = await openWallet(t, amount);
  touched.push(w.id);
  return w;
}

async function walletRow(id: string) {
  const [row] = await t.orm.em
    .getConnection()
    .execute<{ balance: string; version: number }[]>(`select balance::text as balance, version from wallets where id = ?`, [id]);
  return row;
}

async function outboxTypes(walletId: string): Promise<string[]> {
  const rows = await t.orm.em
    .getConnection()
    .execute<{ event_type: string }[]>(`select event_type from outbox_messages where aggregate_id = ? order by occurred_at, id`, [walletId]);
  return rows.map((r) => r.event_type);
}

describe('ProcessWagerTransaction — BET, WIN, LOSS', () => {
  test('BET debita, gera 1 lançamento DEBIT, incrementa version e grava Processed + BalanceChanged', async () => {
    const w = await wallet('100.00');
    const result = await useCase.execute(wagerCommand(w, { money: { amount: '25.00', currency: 'BRL' } }));

    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await walletRow(w.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where transaction_id = ? and direction = 'DEBIT'`, [result.transactionId])).toBe(1);
    expect(await outboxTypes(w.id)).toEqual([
      'WagerTransactionProcessed', // OPENING
      'WalletBalanceChanged', // OPENING
      'WagerTransactionProcessed', // BET
      'WalletBalanceChanged', // BET
    ]);
  });

  test('WIN credita e gera 1 lançamento CREDIT', async () => {
    const w = await wallet('10.00');
    const result = await useCase.execute(wagerCommand(w, { kind: 'WIN', money: { amount: '90.50', currency: 'BRL' } }));
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.50', currency: 'BRL' } });
    expect(await walletRow(w.id)).toEqual({ balance: '100.50', version: 2 });
  });

  test('LOSS é PROCESSED sem lançamento, sem mudar saldo nem version, e só emite WagerTransactionProcessed', async () => {
    const w = await wallet('100.00');
    const result = await useCase.execute(wagerCommand(w, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }));
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await walletRow(w.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where transaction_id = ?`, [result.transactionId])).toBe(0);
    expect((await outboxTypes(w.id)).slice(2)).toEqual(['WagerTransactionProcessed']);
  });
});

describe('ProcessWagerTransaction — rejeições de negócio (com commit)', () => {
  test('BET sem saldo: REJECTED INSUFFICIENT_FUNDS gravada, sem lançamento, saldo intacto, evento Rejected', async () => {
    const w = await wallet('10.00');
    const result = await useCase.execute(wagerCommand(w, { money: { amount: '10.01', currency: 'BRL' } }));

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00', currency: 'BRL' } });
    const [stored] = await t.orm.em
      .getConnection()
      .execute(`select status, failure_code from wager_transactions where id = ?`, [result.transactionId]);
    expect(stored).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await walletRow(w.id)).toEqual({ balance: '10.00', version: 1 });
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where transaction_id = ?`, [result.transactionId])).toBe(0);
    expect((await outboxTypes(w.id)).slice(2)).toEqual(['WagerTransactionRejected']);
  });

  test('playerId diferente do dono da wallet: REJECTED PLAYER_MISMATCH', async () => {
    const w = await wallet();
    const result = await useCase.execute(wagerCommand(w, { playerId: 'someone-else' }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'PLAYER_MISMATCH' });
    expect(await walletRow(w.id)).toEqual({ balance: '100.00', version: 1 });
  });

  test('moeda diferente da wallet: REJECTED CURRENCY_MISMATCH, saldo devolvido na moeda da wallet', async () => {
    const w = await wallet();
    const result = await useCase.execute(wagerCommand(w, { money: { amount: '5.00', currency: 'USD' } }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: { amount: '100.00', currency: 'BRL' } });
  });
});

describe('ProcessWagerTransaction — entradas inválidas (nada é gravado)', () => {
  test.each([
    ['OPENING via use case', { kind: 'OPENING' }, InvalidWagerTransactionError],
    ['BET com referência', { referenceExternalTransactionId: 'x' }, InvalidWagerTransactionError],
    ['valor inválido', { money: { amount: '1e3', currency: 'BRL' } }, InvalidMoneyError],
    ['kind desconhecido', { kind: 'JACKPOT' }, InvalidWagerTransactionError],
  ])('%s', async (_label, overrides, errorClass) => {
    const w = await wallet();
    await expect(useCase.execute(wagerCommand(w, overrides))).rejects.toBeInstanceOf(errorClass);
    expect(await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ? and kind <> 'OPENING'`, [w.id])).toBe(0);
  });

  test.each([
    ['WIN com referência', { kind: 'WIN', referenceExternalTransactionId: 'bet-1' }],
    ['LOSS com referência', { kind: 'LOSS', referenceExternalTransactionId: 'bet-1' }],
    ['REFUND', { kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }],
    ['ROLLBACK', { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }],
  ])('%s com referência inexistente: PENDING_REFERENCE gravada, sem lançamento, evento PendingReference', async (_label, overrides) => {
    const w = await wallet();
    const result = await useCase.execute(wagerCommand(w, { ...overrides, referenceExternalTransactionId: `missing-${newId()}` }));
    expect(result).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await walletRow(w.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where transaction_id = ?`, [result.transactionId])).toBe(0);
    expect((await outboxTypes(w.id)).slice(2)).toEqual(['WagerTransactionPendingReference']);
  });

  test('wallet inexistente (ou id que não é UUID): WalletNotFoundError', async () => {
    const w = await wallet();
    await expect(useCase.execute(wagerCommand(w, { walletId: newId() }))).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(useCase.execute(wagerCommand(w, { walletId: 'not-a-uuid' }))).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe('ProcessWagerTransaction — chave já existente', () => {
  test('mesma idempotency key devolve o registro original e não grava nada novo', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: { amount: '40.00', currency: 'BRL' } });
    const first = await useCase.execute(command);
    const second = await useCase.execute(command);

    expect(second).toEqual({ ...first, idempotentReplay: true });
    expect(await walletRow(w.id)).toEqual({ balance: '60.00', version: 2 });
    expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(1);
  });

  test('payloadHash gravado é o SHA-256 do JSON canônico', async () => {
    const w = await wallet();
    const result = await useCase.execute(wagerCommand(w));
    const [row] = await t.orm.em
      .getConnection()
      .execute<{ payload_hash: string }[]>(`select payload_hash from wager_transactions where id = ?`, [result.transactionId]);
    expect(row?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** Subclasse que falha depois de todas as escritas (saldo já atualizado), antes do commit. */
class FailingBeforeCommit extends ProcessWagerTransaction {
  balanceSeenInsideTransaction: string | undefined;

  constructor(
    t: TestApp,
    private readonly walletId: string,
  ) {
    super(t.orm, t.app.get(Metrics), t.app.get<AppConfig>(APP_CONFIG));
  }

  protected override async beforeCommit(em: EntityManager): Promise<void> {
    const [row] = await em
      .getConnection()
      .execute<{ balance: string }[]>(`select balance::text as balance from wallets where id = ?`, [this.walletId], 'all', em.getTransactionContext());
    this.balanceSeenInsideTransaction = row?.balance;
    throw new Error('simulated crash before commit');
  }
}

describe('atomicidade', () => {
  test('falha após atualizar o saldo e antes do commit: rollback total de saldo, transação, ledger e outbox', async () => {
    const w = await wallet('100.00');
    const snapshot = async () => ({
      wallet: await walletRow(w.id),
      transactions: await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ?`, [w.id]),
      ledger: await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ?`, [w.id]),
      outbox: await countRows(t.orm, `select 1 from outbox_messages where aggregate_id = ?`, [w.id]),
    });
    const before = await snapshot();

    const failing = new FailingBeforeCommit(t, w.id);
    await expect(failing.execute(wagerCommand(w, { money: { amount: '80.00', currency: 'BRL' } }))).rejects.toThrow(
      'simulated crash before commit',
    );

    expect(failing.balanceSeenInsideTransaction).toBe('20.00'); // o UPDATE aconteceu dentro da transação…
    expect(await snapshot()).toEqual(before); // …e foi desfeito junto com todo o resto
    expect(before.wallet).toEqual({ balance: '100.00', version: 1 });
  });
});
