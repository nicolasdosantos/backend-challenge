import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { TcpProxy } from '../support/tcp-proxy';
import { testDatabaseUrl } from '../support/test-env';
import { openWallet, wagerCommand } from '../support/wagering';

/**
 * Banco "pausado": o app fala com o PostgreSQL através de um proxy TCP que, em pausa, descarta
 * todos os bytes (mesmo efeito de `docker compose pause postgres`, que não está disponível
 * dentro do container de testes). Com timeouts curtos, a requisição falha em vez de travar.
 */
const TIMEOUT_MS = 1500;
const POOL_MAX = 4;
let proxy: TcpProxy;
let t: TestApp;
const touched: string[] = [];

beforeAll(async () => {
  const target = new URL(testDatabaseUrl());
  proxy = new TcpProxy(target.hostname, Number(target.port || 5432));
  proxy.start();
  const viaProxy = new URL(target);
  viaProxy.hostname = '127.0.0.1';
  viaProxy.port = String(proxy.port);
  t = await createTestApp({
    databaseUrl: viaProxy.toString(),
    dbQueryTimeoutMs: TIMEOUT_MS,
    dbConnectTimeoutMs: TIMEOUT_MS,
    dbPoolMax: POOL_MAX,
  });
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close(); // sem conexões presas, o pool fecha normalmente
  proxy.stop();
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await fetch(`${t.baseUrl}/health/ready`)).status === 200) return;
    await Bun.sleep(100);
  }
  throw new Error('app did not become ready again');
}

/** Conexões emprestadas pelo pool do `pg` (total − ociosas). */
async function checkedOutConnections(): Promise<number> {
  const pool = (await t.orm.em.getConnection().getNativeClient()) as { totalCount: number; idleCount: number };
  return pool.totalCount - pool.idleCount;
}

describe('PostgreSQL indisponível', () => {
  test('503 + Retry-After + retryable=true em todos os endpoints; ao voltar, o reenvio processa uma única vez', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const command = wagerCommand(w, { money: { amount: '10.00', currency: 'BRL' } });

    proxy.pause();
    try {
      const submit = await fetch(`${t.baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
        body: JSON.stringify({ ...command, idempotencyKey: undefined, correlationId: undefined }),
      });
      expect(submit.status).toBe(503);
      expect(submit.headers.get('retry-after')).toBe('2');
      expect(await submit.json()).toEqual({ code: 'SERVICE_UNAVAILABLE', message: expect.any(String), retryable: true });

      const read = await fetch(`${t.baseUrl}/wallets/${w.id}`);
      expect(read.status).toBe(503);
      expect(((await read.json()) as { code: string }).code).toBe('SERVICE_UNAVAILABLE');

      const ready = await fetch(`${t.baseUrl}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: 'error', checks: { postgres: 'down', sqs: 'up' } });
      expect((await fetch(`${t.baseUrl}/health/live`)).status).toBe(200);
    } finally {
      proxy.resume();
    }

    await waitUntilReady();
    const retry = await submitTransaction(t.baseUrl, command);
    expect(retry.status).toBe(200);
    expect(retry.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(1);
    expect(t.logger.entries.some((e) => e.level === 'error' && JSON.stringify(e.message).includes('SERVICE_UNAVAILABLE'))).toBe(true);
  }, 30_000);

  test('mais falhas de BEGIN do que o tamanho do pool: as conexões voltam e a instância responde 200 sem reiniciar', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const failures = POOL_MAX + 2;

    proxy.pause();
    try {
      for (let i = 0; i < failures; i++) {
        const response = await submitTransaction(t.baseUrl, wagerCommand(w, { money: { amount: '1.00', currency: 'BRL' } }));
        expect(response.status).toBe(503);
      }
    } finally {
      proxy.resume();
    }

    // Sem o patch do kysely, cada BEGIN que falha prende 1 conexão: o pool (4) estaria esgotado
    // e toda requisição seguinte esperaria uma conexão livre até dar 503, para sempre.
    await waitUntilReady();
    expect(await checkedOutConnections()).toBe(0);
    const afterOutage = await submitTransaction(t.baseUrl, wagerCommand(w, { money: { amount: '1.00', currency: 'BRL' } }));
    expect(afterOutage.status).toBe(200);
    expect(afterOutage.body.balance).toEqual({ amount: '99.00', currency: 'BRL' });
    expect(await checkedOutConnections()).toBe(0);
  }, 60_000);
});
