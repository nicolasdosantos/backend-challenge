import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletRecord } from '../../src/database/records';
import { newId } from '../../src/domain/id';
import { CONSUMER_NAME, WagerTransactionConsumer } from '../../src/messaging/wager-transaction.consumer';
import type { ProcessWagerTransactionCommand } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { submitTransaction } from '../support/http';
import { scrapeMetric, startInstance, type Instance } from '../support/instances';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { discardForeignOutboxBacklog, outboxIdsFor, unpublishedFor } from '../support/outbox';
import { createTestQueues, drain, queueDepth, sendWagerMessage, waitFor, type TestQueues } from '../support/sqs';
import { openWallet, wagerCommand } from '../support/wagering';

let q: TestQueues;
let t: TestApp; // processo do teste: prepara dados e confere o banco (consumidor/publisher desligados)
const running: Instance[] = [];
const touched: string[] = [];

beforeAll(async () => {
  q = await createTestQueues();
  t = await createTestApp({ queuePrefix: q.prefix });
});

afterAll(async () => {
  for (const instance of running) {
    if (instance.process.exitCode === null && instance.process.signalCode === null) instance.process.kill('SIGKILL');
  }
  await Promise.all(running.map((i) => i.process.exited));
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
  await q.remove();
});

async function start(port: number, env: Record<string, string> = {}): Promise<Instance> {
  const instance = await startInstance(port, q.prefix, env);
  running.push(instance);
  return instance;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const consumerOn = { SQS_CONSUMER_ENABLED: 'true' };

async function balance(walletId: string) {
  const [row] = await t.orm.em.getConnection().execute<{ balance: string }[]>(`select balance::text as balance from wallets where id = ?`, [walletId]);
  return row?.balance;
}
async function visibleMessages(): Promise<number> {
  const { Attributes } = await q.sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: q.urls.wagerTransactions, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
}

const debits = (walletId: string) =>
  countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);

describe('cenário §13 #5: worker morto depois do commit e antes do ack', () => {
  test('a reentrega é reconhecida pela inbox: 1 transação, 1 lançamento, mensagem some', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    const command = wagerCommand(w, { money: brl('10.00') });

    const crashing = await start(3201, { ...consumerOn, FAULT_CRASH_AFTER_COMMIT: '1' });
    const messageId = await sendWagerMessage(q, command);
    expect(await crashing.process.exited).toBe(1);
    expect(crashing.output()).toContain('FAULT_CRASH_AFTER_COMMIT');

    // Commit feito, ack não: efeito no banco e mensagem ainda na fila.
    expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(1);
    expect(await debits(w.id)).toBe(1);
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(1);

    const healthy = await start(3202, consumerOn);
    await waitFor(async () => (await queueDepth(q, q.urls.wagerTransactions)) === 0, 20_000, 'redelivered message acked');

    expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(1);
    expect(await debits(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
    expect(await countRows(t.orm, `select 1 from inbox_messages where consumer_name = ? and message_id = ?`, [CONSUMER_NAME, messageId])).toBe(1);
    expect(await scrapeMetric(healthy, 'idempotency_duplicates_total', { type: 'inbox' })).toBe(1);
    expect(await scrapeMetric(healthy, 'sqs_messages_consumed_total', { outcome: 'duplicate_delivery' })).toBe(1);

    healthy.process.kill('SIGTERM');
    await healthy.process.exited;
  }, 60_000);
});

describe('SIGTERM com mensagem em andamento', () => {
  test('a mensagem em andamento termina e é confirmada, o processo sai com 0 e as demais ficam visíveis na hora', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    // 3 mensagens em grupos diferentes para chegarem no mesmo lote.
    const commands = [1, 2, 3].map(() => wagerCommand(w, { money: brl('10.00') }));
    for (const command of commands) await sendWagerMessage(q, command, { groupId: `g-${newId()}` });

    // Segura o lock da wallet: a 1ª mensagem do lote fica "em andamento", esperando o lock.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(WalletRecord, { id: w.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      locked();
      await gate;
    });
    await lockTaken;

    const instance = await start(3203, {
      ...consumerOn,
      SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '30', // sem o release, as não iniciadas sumiriam por 30s
      SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '10000',
    });
    await waitFor(
      async () =>
        (await countRows(t.orm, `select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%from "wallets"%for update%'`)) > 0,
      15_000,
      'consumer blocked on the wallet lock',
    );

    instance.process.kill('SIGTERM');
    await Bun.sleep(500);
    release(); // a mensagem em andamento consegue terminar dentro do shutdownTimeout
    await holder;
    const exitCode = await instance.process.exited;

    expect(instance.output()).not.toContain('consumer shutdown timed out');
    // Shutdown gracioso: app.close() rodou os hooks (consumidor drenou) e o processo saiu com 0.
    expect(instance.output()).toContain('consumer stopped');
    expect(instance.output()).toContain('shutdown complete');
    expect(exitCode).toBe(0);
    expect(await debits(w.id)).toBe(1); // só a que estava em andamento

    // As 2 restantes ficam VISÍVEIS bem antes dos 30s de visibility timeout: ou vieram no 1º lote e foram
    // devolvidas no shutdown, ou nem chegaram a ser recebidas (o broker pode entregar um lote menor). A
    // devolução em si é provada de forma determinística em test/integration/sqs-consumer.test.ts.
    await waitFor(async () => (await visibleMessages()) === 2, 5_000, '2 messages visible again');

    const consumer = t.app.get(WagerTransactionConsumer);
    await waitFor(async () => {
      await consumer.pollOnce();
      return (await queueDepth(q, q.urls.wagerTransactions)) === 0;
    }, 15_000, 'remaining messages processed');
    for (const command of commands) {
      expect(await countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [command.idempotencyKey])).toBe(1);
    }
    expect(await balance(w.id)).toBe('70.00');
  }, 60_000);
});

describe('cenário §13 #4 estendido: 3 processos consumindo a mesma fila', () => {
  test('wallet disputada por 3 consumidores com mensagens duplicadas: saldo ≥ 0, sem duplicatas, reconciliação ok', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    // 40 apostas de 5.00 (só 20 cabem) + 10 reenvios com outro messageId e a mesma chave; grupos distintos
    // para os 3 consumidores receberem mensagens da mesma wallet ao mesmo tempo.
    const commands = Array.from({ length: 40 }, () => wagerCommand(w, { money: brl('5.00') }));
    const sends = [...commands, ...commands.slice(0, 10)];
    for (const command of sends) await sendWagerMessage(q, command, { groupId: `g-${newId()}` });

    const consumers = await Promise.all([3204, 3205, 3206].map((port) => start(port, consumerOn)));
    await waitFor(async () => (await queueDepth(q, q.urls.wagerTransactions)) === 0, 40_000, 'queue drained');

    expect(await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ? and kind = 'BET'`, [w.id])).toBe(40);
    expect(await countRows(t.orm, `select 1 from wager_transactions where wallet_id = ? and kind = 'BET' and status = 'PROCESSED'`, [w.id])).toBe(20);
    expect(await debits(w.id)).toBe(20);
    expect(await balance(w.id)).toBe('0.00');
    expect(await queueDepth(q, q.urls.wagerTransactionsDlq)).toBe(0);

    const consumed = await Promise.all(consumers.map((c) => scrapeMetric(c, 'sqs_messages_consumed_total')));
    expect(consumed.reduce((a, b) => a + b, 0)).toBe(50);
    expect(consumed.filter((n) => n > 0).length).toBeGreaterThan(1); // mais de um processo consumiu
    const replays = await Promise.all(consumers.map((c) => scrapeMetric(c, 'sqs_messages_consumed_total', { outcome: 'replay' })));
    expect(replays.reduce((a, b) => a + b, 0)).toBe(10);

    const report = await (await fetch(`${consumers[0]?.url}/wallets/${w.id}/reconciliation`, { method: 'POST' })).json();
    expect(report).toMatchObject({ consistent: true, storedBalance: brl('0.00') });

    for (const c of consumers) c.process.kill('SIGTERM');
    await Promise.all(consumers.map((c) => c.process.exited));
  }, 90_000);
});

describe('cenário §13 #8: reinício do serviço com carga em andamento', () => {
  test('kill das instâncias no meio da carga (API + SQS), novo start: tudo consistente, sem duplicatas nem eventos perdidos', async () => {
    await discardForeignOutboxBacklog(t.orm);
    await drain(q, q.urls.walletEvents, 0);
    const full = { ...consumerOn, OUTBOX_PUBLISHER_ENABLED: 'true', PENDING_REFERENCE_WORKER_ENABLED: 'true' };
    const first = await Promise.all([start(3207, full), start(3208, full)]);

    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(t, '100.00')));
    const walletIds = wallets.map((w) => w.id);
    touched.push(...walletIds);
    const viaQueue: ProcessWagerTransactionCommand[] = [];
    const viaHttp: ProcessWagerTransactionCommand[] = [];
    for (const w of wallets) {
      for (let i = 0; i < 10; i++) (i % 2 === 0 ? viaQueue : viaHttp).push(wagerCommand(w, { money: brl('1.00') }));
    }
    for (const command of viaQueue) await sendWagerMessage(q, command, { groupId: `g-${newId()}` });

    // Requisições HTTP escalonadas; as instâncias morrem (SIGKILL) no meio.
    const httpResults = viaHttp.map((command, i) =>
      Bun.sleep(i * 8)
        .then(() => submitTransaction((first[i % 2] as Instance).url, command))
        .then((r) => r.status === 200)
        .catch(() => false),
    );
    await Bun.sleep(200);
    for (const instance of first) instance.process.kill('SIGKILL');
    const delivered = await Promise.all(httpResults);
    const lost = viaHttp.filter((_, i) => !delivered[i]);
    expect(lost.length).toBeGreaterThan(0); // o kill realmente interrompeu a carga

    // Novo start; o "provedor" reenvia o que não teve resposta (mesma chave).
    const second = await Promise.all([start(3209, full), start(3210, full)]);
    for (const [i, command] of lost.entries()) {
      expect((await submitTransaction((second[i % 2] as Instance).url, command)).status).toBe(200);
    }
    await waitFor(async () => (await queueDepth(q, q.urls.wagerTransactions)) === 0, 60_000, 'wager queue drained');
    await waitFor(async () => (await unpublishedFor(t.orm, walletIds)) === 0, 60_000, 'outbox drained');

    for (const w of wallets) {
      expect(await balance(w.id)).toBe('90.00'); // 10 apostas de 1.00, cada uma exatamente uma vez
      const report = await (await fetch(`${second[0]?.url}/wallets/${w.id}/reconciliation`, { method: 'POST' })).json();
      expect(report).toMatchObject({ consistent: true, checkedEntries: 11 });
    }
    expect(await countRows(t.orm, `select 1 from wager_transactions where wallet_id in (?) and kind = 'BET'`, [walletIds])).toBe(100);

    // Nenhum evento perdido: todo evento da outbox dessas wallets chegou à fila (duplicata é permitida).
    const eventIds = new Set((await drain(q, q.urls.walletEvents)).map((m) => JSON.parse(m.Body ?? '{}').eventId as string));
    for (const id of await outboxIdsFor(t.orm, walletIds)) expect(eventIds.has(id)).toBe(true);

    for (const instance of second) instance.process.kill('SIGTERM');
    await Promise.all(second.map((i) => i.process.exited));
  }, 150_000);
});
