import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/wagering/process-wager-transaction';
import { ReconciliationService } from '../../src/wallets/reconciliation';
import { createTestApp, type TestApp } from '../support/app';
import { expectLedgerConsistent } from '../support/invariants';
import { openWallet, wagerCommand } from '../support/wagering';

let t: TestApp;
let reconciliation: ReconciliationService;
const healthyWallets: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
  reconciliation = t.app.get(ReconciliationService);
});

afterAll(async () => {
  // A wallet corrompida de propósito fica fora da invariante final.
  await expectLedgerConsistent(t.orm, healthyWallets);
  await t.close();
});

async function mismatchCount(): Promise<number> {
  return (await t.metrics.reconciliationMismatches.get()).values[0]?.value ?? 0;
}

describe('reconciliação', () => {
  test('wallet saudável após várias operações: consistent true', async () => {
    const w = await openWallet(t, '100.00');
    healthyWallets.push(w.id);
    const useCase = t.app.get(ProcessWagerTransaction);
    await useCase.execute(wagerCommand(w, { money: { amount: '30.00', currency: 'BRL' } }));
    await useCase.execute(wagerCommand(w, { kind: 'WIN', money: { amount: '12.34', currency: 'BRL' } }));
    await useCase.execute(wagerCommand(w, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }));

    const response = await fetch(`${t.baseUrl}/wallets/${w.id}/reconciliation`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: w.id,
      storedBalance: { amount: '82.34', currency: 'BRL' },
      calculatedBalance: { amount: '82.34', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3, // OPENING + BET + WIN (LOSS não gera lançamento)
    });
  });

  test('saldo corrompido direto no banco de teste: divergência sinalizada, logada, contada e NÃO corrigida', async () => {
    const w = await openWallet(t, '100.00');
    // Corrupção proposital (só no banco de teste): wallets não tem trigger, o ledger continua íntegro.
    await t.orm.em.getConnection().execute(`update wallets set balance = balance + 5 where id = ?`, [w.id]);
    const before = await mismatchCount();

    const report = await reconciliation.reconcile(w.id);

    expect(report).toEqual({
      walletId: w.id,
      storedBalance: { amount: '105.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
    });
    expect(await mismatchCount()).toBe(before + 1);
    expect(t.logger.entries).toContainEqual({
      level: 'error',
      message: expect.objectContaining({ message: 'wallet balance diverges from ledger', walletId: w.id, difference: '5.00' }),
    });

    const [row] = await t.orm.em.getConnection().execute(`select balance::text as balance from wallets where id = ?`, [w.id]);
    expect(row).toEqual({ balance: '105.00' }); // não foi corrigido
  });

  test('wallet inexistente → 404', async () => {
    const response = await fetch(`${t.baseUrl}/wallets/00000000-0000-7000-8000-000000000000/reconciliation`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
