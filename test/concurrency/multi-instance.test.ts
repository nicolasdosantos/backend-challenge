import type { Subprocess } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { testDatabaseUrl, testSqsOptions } from '../support/test-env';
import { openWallet, wagerCommand } from '../support/wagering';

/**
 * Cenário §13 #4: três PROCESSOS independentes da aplicação (sem memória compartilhada),
 * mesmo PostgreSQL. A única coisa em comum entre eles é o banco.
 */
const PORTS = [3101, 3102, 3103];
const PROJECT_ROOT = join(import.meta.dir, '..', '..');

let t: TestApp; // usado só para preparar dados e conferir o banco
const instances: Subprocess[] = [];
const touched: string[] = [];

async function waitForLive(port: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/live`)).ok) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  throw new Error(`instance on port ${port} did not start`);
}

beforeAll(async () => {
  t = await createTestApp(); // aplica as migrations
  for (const port of PORTS) {
    instances.push(
      Bun.spawn(['bun', 'run', 'src/main.ts'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          DATABASE_URL: testDatabaseUrl(),
          DB_POOL_MAX: '20',
          SQS_ENDPOINT: testSqsOptions().endpoint,
          SQS_CONSUMER_ENABLED: 'false',
          OUTBOX_PUBLISHER_ENABLED: 'false',
          PENDING_REFERENCE_WORKER_ENABLED: 'false',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
  }
  await Promise.all(PORTS.map(waitForLive));
}, 30_000);

afterAll(async () => {
  for (const instance of instances) instance.kill('SIGTERM');
  await Promise.all(instances.map((i) => i.exited));
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
});

describe('cenário §13 #4: três instâncias simultâneas', () => {
  test('rajada distribuída entre 3 processos, com chaves repetidas, contra uma wallet disputada', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);

    // 40 apostas distintas de 5.00 (200.00 no total, só 20 cabem no saldo), cada uma enviada
    // 3 vezes — uma para cada instância — tudo ao mesmo tempo: 120 requisições.
    const commands = Array.from({ length: 40 }, () => wagerCommand(w, { money: { amount: '5.00', currency: 'BRL' } }));
    const requests = commands.flatMap((command, i) =>
      PORTS.map((_, j) => {
        const port = PORTS[(i + j) % PORTS.length] as number;
        return submitTransaction(`http://127.0.0.1:${port}`, command).then((r) => ({ ...r, port, key: command.idempotencyKey }));
      }),
    );
    const responses = await Promise.all(requests);

    // Nenhum erro: só 200 (processada) ou 422 (sem saldo).
    expect(responses.filter((r) => r.status !== 200 && r.status !== 422)).toEqual([]);
    for (const port of PORTS) {
      expect(responses.some((r) => r.port === port)).toBe(true);
    }

    // As 3 respostas de cada chave, vindas de processos diferentes, são idênticas (exceto idempotentReplay):
    // a idempotência está no banco, não na memória de nenhuma instância.
    for (const command of commands) {
      const forKey = responses.filter((r) => r.key === command.idempotencyKey);
      expect(forKey).toHaveLength(3);
      expect(new Set(forKey.map((r) => r.body.transactionId)).size).toBe(1);
      expect(new Set(forKey.map((r) => r.status)).size).toBe(1);
      expect(forKey.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    }

    const processedKeys = new Set(responses.filter((r) => r.status === 200).map((r) => r.key));
    expect(processedKeys.size).toBe(20);
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.id])).toBe(20);
    expect(await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ? and kind = 'BET'`, [w.id])).toBe(40);

    const reconciliation = await fetch(`http://127.0.0.1:${PORTS[0]}/wallets/${w.id}/reconciliation`, { method: 'POST' });
    expect(await reconciliation.json()).toMatchObject({
      storedBalance: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 21,
    });
  }, 60_000);
});
