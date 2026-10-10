import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { APP_CONFIG, type AppConfig } from '../../src/config';
import { Metrics } from '../../src/metrics/metrics';
import { PendingReferenceWorker } from '../../src/wagering/pending-reference.worker';
import { ProcessWagerTransaction, type ProcessWagerTransactionCommand } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { openWallet, referencing, wagerCommand } from '../support/wagering';

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

async function credits(walletId: string): Promise<number> {
  return countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'CREDIT'`, [walletId]);
}

describe('reversão dupla concorrente (§ regra estrita, #4)', () => {
  test.each([
    ['REFUND e ROLLBACK da mesma BET', (bet: ProcessWagerTransactionCommand) => [referencing(bet, 'REFUND'), referencing(bet, 'ROLLBACK')]],
    ['dois REFUNDs com externalIds diferentes', (bet: ProcessWagerTransactionCommand) => [referencing(bet, 'REFUND'), referencing(bet, 'REFUND')]],
  ])('%s em paralelo (10 rodadas): exatamente 1 PROCESSED, a outra ALREADY_REVERSED, 1 crédito', async (_label, build) => {
    for (let round = 0; round < 10; round++) {
      const w = await openWallet(t, '100.00');
      touched.push(w.id);
      const bet = wagerCommand(w, { money: brl('25.00') });
      await useCase.execute(bet);

      const results = await Promise.all(build(bet).map((command) => useCase.execute(command)));

      expect(results.map((r) => String(r.status)).sort()).toEqual(['PROCESSED', 'REJECTED']);
      expect(String(results.find((r) => String(r.status) === 'REJECTED')?.failureCode)).toBe('ALREADY_REVERSED');
      expect(await credits(w.id)).toBe(2); // abertura + uma única reversão
      const [row] = await t.orm.em.getConnection().execute(`select balance::text as balance from wallets where id = ?`, [w.id]);
      expect(row).toEqual({ balance: '100.00' });
    }
  });
});

describe('dois workers sobre as mesmas pendências (#9)', () => {
  test('20 REFUNDs pendentes resolvidos por 2 workers ao mesmo tempo: cada crédito aplicado uma única vez', async () => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    const newWorker = () =>
      new PendingReferenceWorker(t.app.get(MikroORM) as MikroORM, useCase, t.app.get(Metrics), config);
    const workerA = newWorker();
    const workerB = newWorker();

    const w = await openWallet(t, '1000.00');
    touched.push(w.id);
    const bets = Array.from({ length: 20 }, () => wagerCommand(w, { money: brl('10.00') }));
    const refundIds: string[] = [];
    for (const bet of bets) {
      refundIds.push((await useCase.execute(referencing(bet, 'REFUND'))).transactionId); // pendente: a BET ainda não existe
    }
    for (const bet of bets) {
      await useCase.execute(bet); // 1000 → 800
    }
    await Bun.sleep(60); // passa o atraso da 1ª reavaliação (20ms nos testes)

    const [outcomesA, outcomesB] = await Promise.all([workerA.processDue(), workerB.processDue()]);
    const all = [...outcomesA, ...outcomesB];

    // Os dois viram as mesmas candidatas; o lock da wallet + releitura garantem um único efeito.
    expect(all.filter((o) => o === 'processed').length).toBeGreaterThanOrEqual(20);
    expect(
      await countRows(t.orm, `select 1 from wager_transactions where id in (?) and status = 'PROCESSED'`, [refundIds]),
    ).toBe(20);
    expect(
      await countRows(t.orm, `select 1 from wallet_ledger_entries where transaction_id in (?)`, [refundIds]),
    ).toBe(20);
    const [row] = await t.orm.em.getConnection().execute(`select balance::text as balance from wallets where id = ?`, [w.id]);
    expect(row).toEqual({ balance: '1000.00' });
  });
});
