import type { PendingReferenceWorker } from '../../src/wagering/pending-reference.worker';
import type { PendingReferenceOutcome } from '../../src/wagering/process-wager-transaction';
import type { TestApp } from './app';
import { countRows } from './invariants';

/**
 * Roda ciclos do worker (os testes desligam o loop automático) até nenhuma das transações
 * indicadas estar em PENDING_REFERENCE. O backoff de teste é curto (20ms, 40ms, 80ms...).
 */
export async function runWorkerUntilSettled(
  t: TestApp,
  worker: PendingReferenceWorker,
  transactionIds: string[],
  maxCycles = 30,
): Promise<PendingReferenceOutcome[]> {
  const outcomes: PendingReferenceOutcome[] = [];
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const pending = await countRows(
      t.orm,
      `select 1 from wager_transactions where id in (?) and status = 'PENDING_REFERENCE'`,
      [transactionIds],
    );
    if (pending === 0) return outcomes;
    await Bun.sleep(60);
    outcomes.push(...(await worker.processDue()));
  }
  throw new Error('pending transactions did not settle');
}
