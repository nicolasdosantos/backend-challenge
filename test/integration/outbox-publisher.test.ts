// Publicador da outbox com PostgreSQL e SQS reais: nada sai antes do commit, os 4 tipos de evento, crash
// entre o envio e a marcação, falha de envio com backoff e a vazão do loop.

import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { APP_CONFIG, type AppConfig } from '../../src/config';
import { newId } from '../../src/domain/id';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';
import { Metrics } from '../../src/metrics/metrics';
import { QUEUE_NAMES } from '../../src/sqs/sqs';
import { ProcessWagerTransaction } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { expectLedgerConsistent } from '../support/invariants';
import { discardForeignOutboxBacklog, outboxIdsFor, unpublishedFor } from '../support/outbox';
import { createTestQueues, drain, type TestQueues } from '../support/sqs';
import { openWallet, referencing, wagerCommand } from '../support/wagering';

let q: TestQueues;
let t: TestApp;
let publisher: OutboxPublisher;
const touched: string[] = [];

beforeAll(async () => {
  q = await createTestQueues();
  t = await createTestApp({ queuePrefix: q.prefix });
  publisher = t.app.get(OutboxPublisher);
  await discardForeignOutboxBacklog(t.orm);
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
  await q.remove();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function publishAll(p: OutboxPublisher = publisher) {
  for (let i = 0; i < 20; i++) {
    if ((await p.publishOnce()).published === 0) return;
  }
}

/** Para a transação de negócio depois de todas as escritas (inclusive a outbox) e antes do commit. */
class PausingBeforeCommit extends ProcessWagerTransaction {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  private reached!: () => void;
  readonly reachedCommit = new Promise<void>((resolve) => (this.reached = resolve));

  letCommit() {
    this.release();
  }

  protected override async beforeCommit(_em: EntityManager): Promise<void> {
    this.reached();
    await this.gate;
  }
}

describe('eliminatório: nenhum evento publicado antes do commit', () => {
  test('com a transação de negócio parada antes do commit, o publisher não publica nada dela; depois do commit, publica', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    await publishAll();
    await drain(q, q.urls.walletEvents, 0); // eventos da abertura fora do caminho

    const pausing = new PausingBeforeCommit(t.orm, t.metrics, t.app.get<AppConfig>(APP_CONFIG));
    const run = pausing.execute(wagerCommand(w, { money: brl('10.00') }));
    await pausing.reachedCommit; // transação, ledger, saldo e 2 eventos já escritos, mas sem commit

    await publisher.publishOnce();
    expect(await unpublishedFor(t.orm, [w.id])).toBe(0); // as linhas não commitadas nem são visíveis
    expect((await drain(q, q.urls.walletEvents, 0)).length).toBe(0);

    pausing.letCommit();
    await run;
    expect(await unpublishedFor(t.orm, [w.id])).toBe(2);
    await publishAll();
    const delivered = (await drain(q, q.urls.walletEvents)).map((m) => JSON.parse(m.Body ?? '{}').eventType);
    expect(delivered.sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
});

describe('publicação da outbox', () => {
  test('os 4 tipos de evento chegam na fila com version, dinheiro em string decimal e aggregateId = walletId', async () => {
    const w = await openWallet(t, '100.00'); // Processed (OPENING) + WalletBalanceChanged
    touched.push(w.id);
    const useCase = t.app.get(ProcessWagerTransaction);
    await useCase.execute(wagerCommand(w, { money: brl('500.00') })); // Rejected
    await useCase.execute(referencing(wagerCommand(w, { money: brl('5.00') }), 'REFUND')); // PendingReference

    await publishAll();
    expect(await unpublishedFor(t.orm, [w.id])).toBe(0);

    const messages = await drain(q, q.urls.walletEvents);
    const events = messages.map((m) => ({ group: m.Attributes?.MessageGroupId, body: JSON.parse(m.Body ?? '{}') }));
    expect(events.map((e) => e.body.eventType).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.group).toBe(w.id);
      expect(event.body).toMatchObject({ aggregateId: w.id, version: 1, eventId: expect.any(String), occurredAt: expect.any(String) });
      expect(typeof event.body.data.money.amount).toBe('string');
      expect(event.body.data.money.amount).toMatch(/^\d+\.\d{2}$/);
    }
    const changed = events.find((e) => e.body.eventType === 'WalletBalanceChanged')?.body.data;
    expect(changed).toMatchObject({ balanceBefore: brl('0.00'), balanceAfter: brl('100.00'), walletVersion: 1 });
  });

  test('crash depois de enviar e antes de marcar: outro publisher reenvia; duplicata forçada é segura com dedup por eventId (#10)', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const eventIds = await outboxIdsFor(t.orm, [w.id]);
    const victim = eventIds[0] as string;

    class CrashingPublisher extends OutboxPublisher {
      protected override async afterSend(eventId: string): Promise<void> {
        if (eventId === victim) throw new Error('simulated crash after send, before marking published');
      }
    }
    const crashing = new CrashingPublisher(t.app.get(MikroORM) as MikroORM, t.app.get(Metrics), q.sqs, t.app.get<AppConfig>(APP_CONFIG));
    await expect(crashing.publishOnce()).rejects.toThrow('simulated crash');
    expect(await unpublishedFor(t.orm, [w.id])).toBe(2); // a transação foi desfeita: nada marcado

    await publishAll(); // outro publisher assume
    expect(await unpublishedFor(t.orm, [w.id])).toBe(0);

    // Duplicata forçada: o mesmo envelope enviado de novo com outro MessageDeduplicationId.
    const [row] = await t.orm.em.getConnection().execute<{ payload: unknown }[]>(`select payload from outbox_messages where id = ?`, [victim]);
    await q.sqs.send(
      new SendMessageCommand({ QueueUrl: q.urls.walletEvents, MessageBody: JSON.stringify(row?.payload), MessageGroupId: w.id, MessageDeduplicationId: newId() }),
    );

    const delivered = (await drain(q, q.urls.walletEvents)).map((m) => JSON.parse(m.Body ?? '{}') as { eventId: string });
    expect(delivered.filter((e) => e.eventId === victim).length).toBeGreaterThanOrEqual(2); // chegou duplicado

    // Consumidor de teste que deduplica pelo eventId de forma persistente (mesma inbox do sistema).
    let effects = 0;
    for (const event of delivered) {
      const inserted = await t.orm.em.getConnection().execute<{ message_id: string }[]>(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         values ('test-wallet-events-consumer', ?, 'h', now(), now())
         on conflict do nothing returning message_id`,
        [event.eventId],
      );
      if (inserted.length === 1) effects++;
    }
    expect(effects).toBe(new Set(delivered.map((e) => e.eventId)).size); // um efeito por evento
    expect(effects).toBe(eventIds.length);
  });

  test('falha de publicação (fila inexistente): attempts sobe, nextAttemptAt respeita o backoff, evento sai quando o SQS volta (#11)', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    await publisher.publishOnce(); // garante as URLs em cache antes de remover a fila
    await drain(q, q.urls.walletEvents, 0);
    const pendingBefore = await openWallet(t, '50.00');
    touched.push(pendingBefore.id);
    const failuresBefore = (await t.metrics.publishFailures.get()).values[0]?.value ?? 0;

    await q.sqs.send(new DeleteQueueCommand({ QueueUrl: q.urls.walletEvents }));
    try {
      const failed = await publisher.publishOnce();
      expect(failed).toMatchObject({ published: 0, failed: 2 });
      const rows = await t.orm.em
        .getConnection()
        .execute<{ attempts: number; delay_ms: string }[]>(
          `select attempts, (extract(epoch from (next_attempt_at - now())) * 1000)::int::text as delay_ms
             from outbox_messages where aggregate_id = ?`,
          [pendingBefore.id],
        );
      expect(rows.map((r) => r.attempts)).toEqual([1, 1]);
      for (const r of rows) expect(Number(r.delay_ms)).toBeGreaterThan(500); // 1ª tentativa: +1s
      expect((await t.metrics.publishFailures.get()).values[0]?.value).toBe(failuresBefore + 2);

      // Ainda dentro do backoff: o próximo ciclo nem tenta.
      expect(await publisher.publishOnce()).toEqual({ published: 0, failed: 0 });
    } finally {
      await q.sqs.send(new CreateQueueCommand({ QueueName: q.prefix + QUEUE_NAMES.walletEvents, Attributes: { FifoQueue: 'true' } }));
    }

    await Bun.sleep(1200);
    await publishAll();
    expect(await unpublishedFor(t.orm, [pendingBefore.id])).toBe(0);
    const delivered = (await drain(q, q.urls.walletEvents)).map((m) => JSON.parse(m.Body ?? '{}').aggregateId);
    expect(delivered.filter((id: string) => id === pendingBefore.id)).toHaveLength(2);
  });
});

describe('loop do publicador', () => {
  test('com lote cheio o próximo ciclo começa na hora: 12 eventos com lote 4 e intervalo de 1s saem em bem menos de 3s', async () => {
    const loop = await createTestApp({ queuePrefix: q.prefix, outbox: { publisherEnabled: true, batchSize: 4, pollIntervalMs: 1000 } });
    try {
      await discardForeignOutboxBacklog(loop.orm);
      const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(loop, '10.00'))); // 12 eventos
      const walletIds = wallets.map((w) => w.id);
      touched.push(...walletIds);

      const started = Date.now();
      while ((await unpublishedFor(loop.orm, walletIds)) > 0 && Date.now() - started < 10_000) {
        await Bun.sleep(50);
      }
      // Sem a continuação imediata seriam 3 ciclos × 1s de intervalo (≥ 3s).
      expect(await unpublishedFor(loop.orm, walletIds)).toBe(0);
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      await loop.close();
    }
    await drain(q, q.urls.walletEvents, 0);
  }, 20_000);
});
