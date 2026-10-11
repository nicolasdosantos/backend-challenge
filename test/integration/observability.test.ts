import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '../../src/domain/id';
import { WagerTransactionConsumer } from '../../src/messaging/wager-transaction.consumer';
import { ProcessWagerTransaction } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { expectLedgerConsistent } from '../support/invariants';
import { createTestQueues, drain, sendWagerMessage, type TestQueues } from '../support/sqs';
import { testDatabaseUrl } from '../support/test-env';
import { openWallet, referencing, wagerCommand } from '../support/wagering';

let q: TestQueues;
let t: TestApp;
const touched: string[] = [];

beforeAll(async () => {
  q = await createTestQueues();
  t = await createTestApp({ queuePrefix: q.prefix });
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
  await q.remove();
});

/** Métricas exigidas pelo enunciado (§12) → nome no /metrics. */
const REQUIRED_METRICS = {
  'transações por status': 'wager_transactions_total',
  'duplicatas detectadas': 'idempotency_duplicates_total',
  'retries do consumidor': 'sqs_consumer_retries_total',
  'retries de PENDING_REFERENCE': 'pending_reference_retries_total',
  'mensagens enviadas à DLQ': 'sqs_dead_lettered_total',
  'mensagens na DLQ': 'sqs_dead_letter_queue_messages',
  'conflitos de lock': 'wallet_lock_conflicts_total',
  'outbox lag': 'outbox_lag_seconds',
  'latência de processamento': 'wager_transaction_processing_seconds',
};

describe('métricas', () => {
  test('GET /metrics expõe todas as métricas exigidas', async () => {
    const body = await (await fetch(`${t.baseUrl}/metrics`)).text();
    for (const [meaning, name] of Object.entries(REQUIRED_METRICS)) {
      expect({ meaning, present: body.includes(`# TYPE ${name} `) }).toEqual({ meaning, present: true });
    }
  });

  test('outbox lag e pendências refletem o banco no momento do scrape (publicador e worker desligados aqui)', async () => {
    const w = await openWallet(t, '100.00'); // 2 eventos não publicados
    touched.push(w.id);
    await t.app.get(ProcessWagerTransaction).execute(referencing(wagerCommand(w, { money: { amount: '5.00', currency: 'BRL' } }), 'REFUND'));
    await Bun.sleep(1100);

    const body = await (await fetch(`${t.baseUrl}/metrics`)).text();
    const gauge = (name: string) => Number(body.split('\n').find((l) => l.startsWith(`${name} `))?.split(' ')[1]);
    expect(gauge('outbox_lag_seconds')).toBeGreaterThanOrEqual(1);
    expect(gauge('wager_transactions_pending_reference')).toBeGreaterThanOrEqual(1);
  });

  test('o gauge da DLQ lê a fila real (inclui mensagens que não passaram pelo consumidor)', async () => {
    await q.sqs.send(
      new SendMessageCommand({ QueueUrl: q.urls.wagerTransactionsDlq, MessageBody: '{}', MessageGroupId: 'g', MessageDeduplicationId: newId() }),
    );
    const body = await (await fetch(`${t.baseUrl}/metrics`)).text();
    expect(body).toContain('sqs_dead_letter_queue_messages 1');
    await drain(q, q.urls.wagerTransactionsDlq);
  });
});

describe('logs estruturados', () => {
  test('API e fila: ids de rastreio presentes; sem valores financeiros, payload ou credenciais', async () => {
    const w = await openWallet(t, '1000.00');
    touched.push(w.id);
    const viaHttp = wagerCommand(w, { money: { amount: '123.45', currency: 'BRL' } });
    const http = await submitTransaction(t.baseUrl, viaHttp, { 'x-correlation-id': 'corr-observability' });
    const viaQueue = wagerCommand(w, { money: { amount: '67.89', currency: 'BRL' } });
    const messageId = await sendWagerMessage(q, viaQueue);
    expect(await t.app.get(WagerTransactionConsumer).pollOnce()).toEqual(['processed']);

    const handled = t.logger.entries
      .map((e) => e.message as Record<string, unknown>)
      .filter((m) => typeof m === 'object' && m?.message === 'wager transaction handled');
    expect(handled).toContainEqual(
      expect.objectContaining({
        correlationId: 'corr-observability',
        transactionId: http.body.transactionId,
        walletId: w.id,
        providerId: 'provider-a',
      }),
    );
    expect(handled).toContainEqual(
      expect.objectContaining({ correlationId: messageId, messageId, walletId: w.id, providerId: 'provider-a', transactionId: expect.any(String) }),
    );

    const allLogs = JSON.stringify(t.logger.entries);
    const db = new URL(testDatabaseUrl());
    const databaseCredentials = `${db.username}:${db.password}@`; // a senha sozinha ("wagering") coincide com o nome da rota
    for (const forbidden of ['123.45', '67.89', '"money"', '"amount"', databaseCredentials, testDatabaseUrl()]) {
      expect({ forbidden, found: allLogs.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
  });
});

describe('health', () => {
  test('/health/ready responde 503 com sqs "down" quando o SQS está inacessível; /metrics continua respondendo', async () => {
    // Cliente SQS apontando para uma porta sem nada escutando.
    const app = await createTestAppWithSqsEndpoint('http://127.0.0.1:9');
    try {
      const response = await fetch(`${app.baseUrl}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'error', checks: { postgres: 'up', sqs: 'down' } });
      const metrics = await fetch(`${app.baseUrl}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain('sqs_dead_letter_queue_messages -1');
    } finally {
      await app.close();
    }
  });
});

async function createTestAppWithSqsEndpoint(endpoint: string): Promise<TestApp> {
  const previous = process.env.SQS_ENDPOINT;
  process.env.SQS_ENDPOINT = endpoint;
  try {
    return await createTestApp({ queuePrefix: q.prefix });
  } finally {
    process.env.SQS_ENDPOINT = previous;
  }
}
