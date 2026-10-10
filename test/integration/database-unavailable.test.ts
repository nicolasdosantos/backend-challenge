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
 * dentro do container de testes). Com query_timeout curto, a requisição falha em vez de travar.
 */
const QUERY_TIMEOUT_MS = 1500;
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
  t = await createTestApp({ databaseUrl: viaProxy.toString(), dbQueryTimeoutMs: QUERY_TIMEOUT_MS });
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  // BUG CONHECIDO (kysely 0.29.6, usado pelo MikroORM 7): quando o BEGIN falha por timeout, a conexão
  // nunca volta ao pool, e o pool.end() do close() espera por ela para sempre. Prazo limitado aqui
  // para não esconder o restante da suíte; ver ARCHITECTURE.md §11 (Problemas conhecidos).
  await Promise.race([t.close(), Bun.sleep(2000)]);
  proxy.stop();
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await fetch(`${t.baseUrl}/health/ready`)).status === 200) return;
    await Bun.sleep(100);
  }
  throw new Error('app did not become ready again');
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

  // Pendente de decisão (patch no kysely): hoje 1 conexão fica presa a cada BEGIN que falha.
  test.todo('a conexão volta ao pool quando o BEGIN da transação falha por indisponibilidade do banco', () => {});
});
