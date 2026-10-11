// Health checks e /metrics com a app NestJS real, PostgreSQL e filas reais.

import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createSqsClient, ensureQueues, type QueueUrls } from '../../src/sqs/sqs';
import { createTestApp, type TestApp } from '../support/app';
import { testSqsOptions, uniqueQueuePrefix } from '../support/test-env';

describe('health checks e métricas (app NestJS real)', () => {
  const sqs = createSqsClient(testSqsOptions());
  const queuePrefix = uniqueQueuePrefix();
  let queues: QueueUrls;
  let t: TestApp;

  beforeAll(async () => {
    queues = await ensureQueues(sqs, queuePrefix);
    t = await createTestApp({ queuePrefix });
  });

  afterAll(async () => {
    await t.close();
    for (const url of Object.values(queues)) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
  });

  test('GET /health/live responde 200', async () => {
    const response = await fetch(`${t.baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('GET /health/ready responde 200 com PostgreSQL e SQS alcançáveis', async () => {
    const response = await fetch(`${t.baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('GET /metrics expõe as métricas no formato Prometheus', async () => {
    const response = await fetch(`${t.baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    for (const name of [
      'wager_transactions_total',
      'wager_transaction_processing_seconds',
      'wallet_lock_conflicts_total',
      'reconciliation_mismatches_total',
    ]) {
      expect(body).toContain(`# TYPE ${name}`);
    }
  });
});
