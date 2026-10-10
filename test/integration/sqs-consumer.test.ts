import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { APP_CONFIG, type AppConfig } from '../../src/config';
import { newId } from '../../src/domain/id';
import { CONSUMER_NAME, WagerTransactionConsumer } from '../../src/messaging/wager-transaction.consumer';
import { PendingReferenceWorker } from '../../src/wagering/pending-reference.worker';
import { ProcessWagerTransaction } from '../../src/wagering/process-wager-transaction';
import { createTestApp, type TestApp } from '../support/app';
import { countRows, expectLedgerConsistent } from '../support/invariants';
import { createTestQueues, drain, queueDepth, sendRaw, sendWagerMessage, wagerMessageBody, type TestQueues } from '../support/sqs';
import { openWallet, referencing, wagerCommand } from '../support/wagering';
import { runWorkerUntilSettled } from '../support/worker';

let q: TestQueues;
let t: TestApp;
let consumer: WagerTransactionConsumer;
const touched: string[] = [];

beforeAll(async () => {
  q = await createTestQueues();
  t = await createTestApp({ queuePrefix: q.prefix });
  consumer = t.app.get(WagerTransactionConsumer);
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
  await q.remove();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function wallet(amount = '100.00') {
  const w = await openWallet(t, amount);
  touched.push(w.id);
  return w;
}

async function balance(walletId: string) {
  const [row] = await t.orm.em.getConnection().execute<{ balance: string }[]>(`select balance::text as balance from wallets where id = ?`, [walletId]);
  return row?.balance;
}

const inboxRows = (messageId: string) =>
  countRows(t.orm, `select 1 from inbox_messages where consumer_name = ? and message_id = ?`, [CONSUMER_NAME, messageId]);
const transactionsFor = (key: string) => countRows(t.orm, `select 1 from wager_transactions where idempotency_key = ?`, [key]);

describe('consumidor SQS', () => {
  test('cenário feliz: BET → PROCESSED, ledger, inbox, eventos na outbox e mensagem apagada (#1)', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: brl('25.00') });
    const messageId = await sendWagerMessage(q, command);

    expect(await consumer.pollOnce()).toEqual(['processed']);

    expect(await balance(w.id)).toBe('75.00');
    expect(await transactionsFor(command.idempotencyKey)).toBe(1);
    expect(await inboxRows(messageId)).toBe(1);
    expect(await countRows(t.orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.id])).toBe(1);
    const events = await t.orm.em
      .getConnection()
      .execute<{ event_type: string; causation: string }[]>(
        `select event_type, payload->>'causationId' as causation from outbox_messages
          where payload->'data'->>'transactionId' = (select id::text from wager_transactions where idempotency_key = ?)
          order by id`,
        [command.idempotencyKey],
      );
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', causation: messageId },
      { event_type: 'WalletBalanceChanged', causation: messageId },
    ]);
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(0);
  });

  test('redelivery: o mesmo messageId entregue duas vezes, em paralelo, a dois consumidores → 1 efeito, 1 inbox (#2)', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: brl('10.00') });
    const { messageId, body } = wagerMessageBody(command);
    // Duas entregas da MESMA mensagem: grupos e deduplication ids diferentes para chegarem juntas.
    await sendRaw(q, body, { groupId: `g1-${newId()}` });
    await sendRaw(q, body, { groupId: `g2-${newId()}` });
    const duplicatesBefore = (await t.metrics.duplicates.get()).values.find((v) => v.labels.type === 'inbox')?.value ?? 0;

    const otherConsumer = new WagerTransactionConsumer(
      t.app.get(ProcessWagerTransaction),
      t.metrics,
      q.sqs,
      t.app.get<AppConfig>(APP_CONFIG),
    );
    const [a, b] = await Promise.all([consumer.pollOnce(), otherConsumer.pollOnce()]);
    const outcomes = [...a, ...b];
    // Se um consumidor receber as duas no mesmo lote, processa em sequência; o resultado é o mesmo.
    expect(outcomes.sort()).toEqual(['duplicate_delivery', 'processed']);
    expect(await balance(w.id)).toBe('90.00');
    expect(await inboxRows(messageId)).toBe(1);
    expect(await transactionsFor(command.idempotencyKey)).toBe(1);
    expect((await t.metrics.duplicates.get()).values.find((v) => v.labels.type === 'inbox')?.value).toBe(duplicatesBefore + 1);
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(0);
  });

  test('mesma operação com outro messageId e a mesma idempotencyKey → replay, sem efeito duplo (#3)', async () => {
    const w = await wallet('100.00');
    const command = wagerCommand(w, { money: brl('10.00') });
    await sendWagerMessage(q, command);
    expect(await consumer.pollOnce()).toEqual(['processed']);
    await sendWagerMessage(q, command); // novo messageId, mesma chave
    expect(await consumer.pollOnce()).toEqual(['replay']);
    expect(await balance(w.id)).toBe('90.00');
    expect(await transactionsFor(command.idempotencyKey)).toBe(1);
  });

  test('rejeição de negócio via fila: REJECTED persistido, ack, nada na DLQ (#5)', async () => {
    const w = await wallet('10.00');
    const command = wagerCommand(w, { money: brl('50.00') });
    await sendWagerMessage(q, command);
    expect(await consumer.pollOnce()).toEqual(['rejected']);
    const [row] = await t.orm.em.getConnection().execute(`select status, failure_code from wager_transactions where idempotency_key = ?`, [command.idempotencyKey]);
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(0);
    expect(await queueDepth(q, q.urls.wagerTransactionsDlq)).toBe(0);
  });

  test('PENDING_REFERENCE via fila: ack, e o worker resolve depois (#5)', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, { money: brl('20.00') });
    const refund = referencing(bet, 'REFUND');
    await sendWagerMessage(q, refund);
    expect(await consumer.pollOnce()).toEqual(['pending_reference']);
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(0);

    await sendWagerMessage(q, bet);
    expect(await consumer.pollOnce()).toEqual(['processed']);
    const [refundRow] = await t.orm.em
      .getConnection()
      .execute<{ id: string }[]>(`select id from wager_transactions where idempotency_key = ?`, [refund.idempotencyKey]);
    await runWorkerUntilSettled(t, t.app.get(PendingReferenceWorker), [refundRow?.id ?? '']);
    expect(await balance(w.id)).toBe('100.00');
  });
});

describe('mensagens permanentemente inválidas vão direto à DLQ, com motivo (#7)', () => {
  test.each([
    ['JSON inválido', () => ({ body: '{"messageId": ', group: 'g' }), 'INVALID_JSON'],
    ['type desconhecido', () => ({ body: JSON.stringify({ messageId: 'm', type: 'Other', occurredAt: new Date().toISOString(), data: {} }), group: 'g' }), 'UNKNOWN_MESSAGE_TYPE'],
    ['envelope sem idempotencyKey', () => ({ body: JSON.stringify({ messageId: 'm', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: {} }), group: 'g' }), 'INVALID_ENVELOPE'],
  ])('%s → DLQ', async (_label, build, reason) => {
    const { body, group } = build();
    await sendRaw(q, body, { groupId: group });
    expect(await consumer.pollOnce()).toEqual(['dead_letter']);
    const dead = await drain(q, q.urls.wagerTransactionsDlq);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.Body).toBe(body);
    expect(dead[0]?.MessageAttributes?.reason?.StringValue).toBe(reason);
    expect(await queueDepth(q, q.urls.wagerTransactions)).toBe(0);
  });

  test('wallet inexistente, OPENING e messageId reutilizado com outro payload → DLQ com motivo, sem efeito', async () => {
    const w = await wallet('100.00');
    const deadBefore = (await t.metrics.deadLettered.get()).values.reduce((s, v) => s + v.value, 0);

    await sendWagerMessage(q, wagerCommand(w, { walletId: newId() }));
    await sendWagerMessage(q, wagerCommand(w, { kind: 'OPENING' }));
    const original = wagerCommand(w, { money: brl('10.00') });
    const messageId = await sendWagerMessage(q, original);
    expect((await consumer.pollOnce()).sort()).toEqual(['dead_letter', 'dead_letter', 'processed']);

    // Mesmo messageId, payload diferente (outro valor): conflito de inbox.
    await sendWagerMessage(q, { ...original, money: brl('99.00') }, { messageId, deduplicationId: newId() });
    expect(await consumer.pollOnce()).toEqual(['dead_letter']);

    const reasons = (await drain(q, q.urls.wagerTransactionsDlq)).map((m) => m.MessageAttributes?.reason?.StringValue).sort();
    expect(reasons).toEqual(['INBOX_PAYLOAD_CONFLICT', 'INVALID_PAYLOAD', 'WALLET_NOT_FOUND']);
    expect((await t.metrics.deadLettered.get()).values.reduce((s, v) => s + v.value, 0)).toBe(deadBefore + 3);
    expect(await balance(w.id)).toBe('90.00'); // só a mensagem válida teve efeito
    expect(await inboxRows(messageId)).toBe(1);
  });
});
