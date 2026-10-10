import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { InboxMessage } from '../../src/domain/inbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/integration-events';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { brl, processedBet, wagerProps } from '../support/builders';

const at = new Date('2026-10-10T12:00:00Z');
const ctx = { correlationId: 'corr-1', causationId: 'msg-1', at };

describe('Integration events', () => {
  test('WalletBalanceChanged: envelope com tipo e versão no próprio tipo, dinheiro como string decimal', () => {
    const wallet = Wallet.open({ playerId: 'p1', initialBalance: brl('100.00'), at });
    const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', at });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-10T12:00:00.000Z',
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(typeof json.eventId).toBe('string');
  });

  test('WagerTransactionProcessed (inclusive LOSS) e Rejected carregam dados da transação', () => {
    const loss = WagerTransaction.create(wagerProps({ kind: WagerTransactionKind.Loss, money: brl('0') }));
    loss.markProcessed(undefined, at, brl('100.00'));
    const processedJson = WagerTransactionProcessed.from(loss, ctx).toJSON();
    expect(processedJson.eventType).toBe('WagerTransactionProcessed');
    expect(processedJson.data).toMatchObject({ kind: 'LOSS', balanceAfter: { amount: '100.00', currency: 'BRL' } });

    const rejected = WagerTransaction.create(wagerProps());
    rejected.reject(FailureCode.InsufficientFunds, at, brl('20.00'));
    const rejectedJson = JSON.parse(JSON.stringify(WagerTransactionRejected.from(rejected, ctx)));
    expect(rejectedJson.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('WagerTransactionPendingReference inclui a referência aguardada', () => {
    const refund = WagerTransaction.create(
      wagerProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' }),
    );
    refund.markPendingReference(at);
    const json = WagerTransactionPendingReference.from(refund, ctx).toJSON();
    expect(json.data.referenceExternalTransactionId).toBe('bet-1');
  });

  test('o envelope é JSON estável (round-trip sem perda)', () => {
    const json = WagerTransactionProcessed.from(processedBet(), ctx).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('OutboxMessage', () => {
  const event = () => WagerTransactionProcessed.from(processedBet(), ctx);

  test('enqueue usa o eventId como id e grava o envelope completo', () => {
    const e = event();
    const message = OutboxMessage.enqueue(e);
    expect(message.id).toBe(e.eventId);
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(e.toJSON())));
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
  });

  test('scheduleRetry aplica backoff exponencial com teto', () => {
    const message = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      message.scheduleRetry(at);
      delays.push((message.nextAttemptAt?.getTime() ?? 0) - at.getTime());
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(delays.at(-1)).toBe(5 * 60_000);
    expect(message.attempts).toBe(12);
    expect(message.isDue(at)).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 5 * 60_000))).toBe(true);
  });

  test('markPublished encerra a mensagem e não pode ser repetido', () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at)).toBe(false);
    expect(() => message.markPublished(at)).toThrow(DomainError);
  });
});

describe('InboxMessage', () => {
  test('receive → markProcessed, sem processar duas vezes', () => {
    const inbox = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-consumer', payloadHash: 'h', at });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(at)).toThrow(DomainError);
  });

  test('messageId e consumerName são obrigatórios', () => {
    expect(() => InboxMessage.receive({ messageId: '', consumerName: 'c', payloadHash: 'h', at })).toThrow(DomainError);
  });
});
