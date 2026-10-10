import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WagerTransactionConsumer, type ConsumeOutcome } from '../../src/messaging/wager-transaction.consumer';
import { createTestApp, type TestApp } from '../support/app';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { createTestQueues, drain, queueDepth, sendWagerMessage, waitFor, type TestQueues } from '../support/sqs';
import { TcpProxy } from '../support/tcp-proxy';
import { testDatabaseUrl } from '../support/test-env';
import { openWallet, wagerCommand } from '../support/wagering';

/**
 * Falhas transitórias: o app fala com o PostgreSQL por um proxy TCP de teste que, em pausa,
 * descarta os bytes (mesmo efeito de `docker compose pause postgres`). Filas com
 * maxReceiveCount = 2 e backoff de 1s, 2s... para os testes rodarem rápido.
 */
const MAX_RECEIVE_COUNT = 2;
let q: TestQueues;
let proxy: TcpProxy;
let t: TestApp;
let consumer: WagerTransactionConsumer;
const touched: string[] = [];

beforeAll(async () => {
  q = await createTestQueues(MAX_RECEIVE_COUNT);
  const target = new URL(testDatabaseUrl());
  proxy = new TcpProxy(target.hostname, Number(target.port || 5432));
  proxy.start();
  const viaProxy = new URL(target);
  viaProxy.hostname = '127.0.0.1';
  viaProxy.port = String(proxy.port);
  t = await createTestApp({
    queuePrefix: q.prefix,
    databaseUrl: viaProxy.toString(),
    dbQueryTimeoutMs: 1500,
    dbConnectTimeoutMs: 1500,
  });
  consumer = t.app.get(WagerTransactionConsumer);
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
  proxy.stop();
  await q.remove();
});

async function pollUntil(predicate: (outcomes: ConsumeOutcome[]) => boolean, maxPolls = 15): Promise<ConsumeOutcome[]> {
  const seen: ConsumeOutcome[] = [];
  for (let i = 0; i < maxPolls; i++) {
    const outcomes = await consumer.pollOnce();
    seen.push(...outcomes);
    if (predicate(outcomes)) return seen;
  }
  throw new Error(`condition not reached; outcomes: ${seen.join(',')}`);
}

describe('erros transitórios no consumidor', () => {
  test('banco indisponível: a mensagem não é apagada, volta com backoff e é processada uma única vez quando o banco volta (#6)', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const command = wagerCommand(w, { money: { amount: '10.00', currency: 'BRL' } });
    await sendWagerMessage(q, command);
    const retriesBefore = (await t.metrics.consumerRetries.get()).values[0]?.value ?? 0;

    proxy.pause();
    try {
      expect(await consumer.pollOnce()).toEqual(['retry']);
    } finally {
      proxy.resume();
    }
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(1); // não foi apagada
    expect((await t.metrics.consumerRetries.get()).values[0]?.value).toBe(retriesBefore + 1);

    await waitFor(async () => (await fetch(`${t.baseUrl}/health/ready`)).status === 200, 10_000, 'app ready');
    const outcomes = await pollUntil((o) => o.includes('processed'));
    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);

    expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(1);
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.id])).toBe(1);
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(0);
  }, 30_000);

  test('backoff calculado pelo ApproximateReceiveCount: a 1ª falha esconde a mensagem por 1s', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    await sendWagerMessage(q, wagerCommand(w, { money: { amount: '1.00', currency: 'BRL' } }));

    proxy.pause();
    try {
      expect(await consumer.pollOnce()).toEqual(['retry']);
    } finally {
      proxy.resume();
    }
    // Logo depois da falha a mensagem ainda está invisível; em seguida reaparece com receiveCount 2.
    const immediately = await q.sqs.send(new ReceiveMessageCommand({ QueueUrl: q.urls.wagerTransactions, WaitTimeSeconds: 0 }));
    expect(immediately.Messages ?? []).toHaveLength(0);
    await waitFor(async () => (await fetch(`${t.baseUrl}/health/ready`)).status === 200, 10_000, 'app ready');
    expect(await pollUntil((o) => o.length > 0)).toEqual(['processed']);
  }, 30_000);

  test('transitório que excede maxReceiveCount cai na DLQ pela redrive policy, sem efeito no banco (#7)', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const command = wagerCommand(w, { money: { amount: '5.00', currency: 'BRL' } });
    await sendWagerMessage(q, command);

    proxy.pause();
    try {
      // receive 1 e 2 falham (backoff 1s, 2s); na 3ª tentativa o SQS move a mensagem para a DLQ.
      await waitFor(
        async () => {
          await consumer.pollOnce();
          return (await queueDepth(q, q.urls.wagerTransactions)) === 0;
        },
        20_000,
        'message leaves main queue',
      );
    } finally {
      proxy.resume();
    }

    const dead = await drain(q, q.urls.wagerTransactionsDlq);
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0]?.Body ?? '{}').data.idempotencyKey).toBe(command.idempotencyKey);
    await waitFor(async () => (await fetch(`${t.baseUrl}/health/ready`)).status === 200, 10_000, 'app ready');
    expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(0);
  }, 40_000);
});
