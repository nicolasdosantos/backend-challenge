import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { APP_CONFIG, type AppConfig } from '../../src/config';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';
import { Metrics } from '../../src/metrics/metrics';
import { createTestApp, type TestApp } from '../support/app';
import { expectLedgerConsistent } from '../support/invariants';
import { discardForeignOutboxBacklog, outboxIdsFor, unpublishedFor } from '../support/outbox';
import { createTestQueues, drain, type TestQueues } from '../support/sqs';
import { openWallet } from '../support/wagering';

let q: TestQueues;
let t: TestApp;
const touched: string[] = [];

beforeAll(async () => {
  q = await createTestQueues();
  t = await createTestApp({ queuePrefix: q.prefix, outbox: { batchSize: 10 } });
  await discardForeignOutboxBacklog(t.orm);
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
  await q.remove();
});

describe('cenário §13 #6: dois publishers sobre a mesma outbox', () => {
  test('60 eventos publicados por 2 publishers simultâneos: todos chegam, nenhum enviado duas vezes', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => openWallet(t, '10.00'))); // 2 eventos cada
    const walletIds = wallets.map((w) => w.id);
    touched.push(...walletIds);
    const expected = await outboxIdsFor(t.orm, walletIds);
    expect(expected).toHaveLength(60);

    const newPublisher = () =>
      new OutboxPublisher(t.app.get(MikroORM) as MikroORM, t.app.get(Metrics), q.sqs, t.app.get<AppConfig>(APP_CONFIG));
    const [a, b] = [newPublisher(), newPublisher()];
    let sentByA = 0;
    let sentByB = 0;
    for (let round = 0; round < 20 && (await unpublishedFor(t.orm, walletIds)) > 0; round++) {
      const [ra, rb] = await Promise.all([a.publishOnce(), b.publishOnce()]);
      sentByA += ra.published;
      sentByB += rb.published;
    }

    expect(await unpublishedFor(t.orm, walletIds)).toBe(0);
    expect(sentByA).toBeGreaterThan(0);
    expect(sentByB).toBeGreaterThan(0); // os dois trabalharam (lotes disjuntos pelo SKIP LOCKED)
    expect(sentByA + sentByB).toBe(60); // nenhum evento enviado duas vezes

    const delivered = (await drain(q, q.urls.walletEvents)).map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
    expect(delivered.sort()).toEqual([...expected].sort()); // todos, exatamente uma vez
  });
});
