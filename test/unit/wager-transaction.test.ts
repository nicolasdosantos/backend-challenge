import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { brl, processedBet, wagerProps } from '../support/builders';

const at = new Date('2026-10-10T12:00:00Z');

function processed(kind: Kind, overrides = {}) {
  const tx = WagerTransaction.create(wagerProps({ kind, ...overrides }));
  tx.markProcessed(kind === Kind.Refund || kind === Kind.Rollback ? 'ref-id' : undefined, at, brl('100.00'));
  return tx;
}

describe('WagerTransaction — criação', () => {
  test('nasce em PENDING', () => {
    const tx = WagerTransaction.create(wagerProps());
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING não pode ser submetido por provedor', () => {
    expect(() => WagerTransaction.create(wagerProps({ kind: Kind.Opening }))).toThrow(InvalidWagerTransactionError);
  });

  test('OPENING interno é criado pela factory própria', () => {
    const tx = WagerTransaction.opening({ walletId: 'w1', playerId: 'p1', money: brl('100.00') });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => WagerTransaction.create(wagerProps({ kind }))).toThrow(InvalidWagerTransactionError);
    expect(WagerTransaction.create(wagerProps({ kind, referenceExternalTransactionId: 'bet-1' })).requiresReference()).toBe(true);
  });

  test('BET com referência é payload inválido', () => {
    expect(() => WagerTransaction.create(wagerProps({ kind: Kind.Bet, referenceExternalTransactionId: 'x' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([Kind.Win, Kind.Loss])('%s aceita referência opcional', (kind) => {
    expect(WagerTransaction.create(wagerProps({ kind })).referenceExternalTransactionId).toBeUndefined();
    expect(WagerTransaction.create(wagerProps({ kind, referenceExternalTransactionId: 'bet-1' })).referenceExternalTransactionId).toBe('bet-1');
  });

  test('referência vazia é inválida', () => {
    expect(() => WagerTransaction.create(wagerProps({ kind: Kind.Refund, referenceExternalTransactionId: '' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(WagerTransaction.create(wagerProps({ kind: Kind.Loss, money: brl('0') })).money.isZero()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => WagerTransaction.create(wagerProps({ kind, money: brl('0') }))).toThrow(InvalidWagerTransactionError);
    }
  });

  test('kind desconhecido e campos vazios são inválidos', () => {
    expect(() => WagerTransaction.create(wagerProps({ kind: 'JACKPOT' as Kind }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(wagerProps({ roundId: '' }))).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction — regras por tipo', () => {
  test('BET debita; WIN e REFUND creditam; LOSS não afeta saldo nem gera lançamento', () => {
    expect(WagerTransaction.create(wagerProps({ kind: Kind.Bet })).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(WagerTransaction.create(wagerProps({ kind: Kind.Win })).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      WagerTransaction.create(wagerProps({ kind: Kind.Refund, referenceExternalTransactionId: 'b' })).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);

    const loss = WagerTransaction.create(wagerProps({ kind: Kind.Loss }));
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rollback = WagerTransaction.create(wagerProps({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' }));
    expect(rollback.ledgerDirectionFor(processedBet())).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processed(Kind.Refund, { referenceExternalTransactionId: 'b' }))).toBe(
      LedgerDirection.Debit,
    );
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — validação da referência (função única)', () => {
  const bet = processedBet({ externalTransactionId: 'bet-1', money: brl('25.00') });
  const reversal = (kind: Kind, overrides = {}) =>
    WagerTransaction.create(wagerProps({ kind, referenceExternalTransactionId: 'bet-1', money: brl('25.00'), ...overrides }));

  test.each([Kind.Refund, Kind.Rollback, Kind.Win, Kind.Loss])('%s referenciando BET processada válida', (kind) => {
    expect(reversal(kind).checkReference(bet)).toEqual({ outcome: 'valid' });
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['rodada', { roundId: 'round-2' }],
    ['moeda', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
  ])('referência de outro(a) %s → REFERENCE_MISMATCH', (_label, overrides) => {
    expect(reversal(Kind.Refund, overrides).checkReference(bet)).toEqual({
      outcome: 'invalid',
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test('REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND', () => {
    const win = processed(Kind.Win, { externalTransactionId: 'win-1', money: brl('25.00') });
    const refund = processed(Kind.Refund, { referenceExternalTransactionId: 'bet-1', money: brl('25.00') });
    const rollback = processed(Kind.Rollback, { referenceExternalTransactionId: 'bet-1', money: brl('25.00') });

    expect(reversal(Kind.Refund).checkReference(win)).toEqual({ outcome: 'invalid', failureCode: FailureCode.InvalidReferenceKind });
    expect(reversal(Kind.Rollback).checkReference(win)).toEqual({ outcome: 'valid' });
    expect(reversal(Kind.Rollback).checkReference(refund)).toEqual({ outcome: 'valid' });
    expect(reversal(Kind.Rollback).checkReference(rollback)).toEqual({
      outcome: 'invalid',
      failureCode: FailureCode.InvalidReferenceKind,
    });
    expect(reversal(Kind.Win).checkReference(win)).toEqual({ outcome: 'invalid', failureCode: FailureCode.InvalidReferenceKind });
  });

  test('reversão com valor diferente da referência → AMOUNT_MISMATCH (WIN pode ter outro valor)', () => {
    expect(reversal(Kind.Refund, { money: brl('10.00') }).checkReference(bet)).toEqual({
      outcome: 'invalid',
      failureCode: FailureCode.AmountMismatch,
    });
    expect(reversal(Kind.Win, { money: brl('500.00') }).checkReference(bet)).toEqual({ outcome: 'valid' });
  });

  test('referência REJECTED ou FAILED → REFERENCE_NOT_PROCESSED', () => {
    const rejected = WagerTransaction.create(wagerProps({ externalTransactionId: 'bet-1', money: brl('25.00') }));
    rejected.reject(FailureCode.InsufficientFunds, at, brl('0.00'));
    expect(reversal(Kind.Refund).checkReference(rejected)).toEqual({
      outcome: 'invalid',
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });

  test('referência ainda pendente → aguardar', () => {
    const pending = WagerTransaction.create(wagerProps({ externalTransactionId: 'bet-1', money: brl('25.00') }));
    expect(reversal(Kind.Refund).checkReference(pending)).toEqual({ outcome: 'wait' });
  });
});

describe('WagerTransaction — estados', () => {
  test('PENDING → PROCESSED registra referência, instante e saldo resultante', () => {
    const tx = WagerTransaction.create(wagerProps());
    tx.markProcessed(undefined, at, brl('75.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toBe(at);
    expect(tx.resultBalance?.amount).toBe('75.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('reversão não pode ser processada sem a referência resolvida', () => {
    const tx = WagerTransaction.create(wagerProps({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }));
    expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING → REJECTED carrega failureCode', () => {
    const tx = WagerTransaction.create(wagerProps());
    tx.reject(FailureCode.InsufficientFunds, at, brl('20.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING → FAILED carrega failureCode', () => {
    const tx = WagerTransaction.create(wagerProps());
    tx.fail(FailureCode.InternalError, at);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const tx = WagerTransaction.create(wagerProps({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }));
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('ref-id', at, brl('100.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref-id');
  });

  test('PENDING_REFERENCE → REJECTED quando a referência nunca chega', () => {
    const tx = WagerTransaction.create(wagerProps({ kind: Kind.Rollback, referenceExternalTransactionId: 'b' }));
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound, at, brl('100.00'));
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('transação sem referência não pode aguardar referência', () => {
    expect(() => WagerTransaction.create(wagerProps()).markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, at, brl('1.00'))],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, at, brl('1.00'))],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.InternalError, at)],
  ])('estado terminal %s não aceita nenhuma transição', (_label, toTerminal) => {
    const tx = WagerTransaction.create(wagerProps());
    toTerminal(tx);
    expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InternalError, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — idempotência', () => {
  test('matchesPayload distingue replay de payload divergente com a mesma chave', () => {
    const tx = WagerTransaction.create(wagerProps({ payloadHash: 'hash-original' }));
    expect(tx.matchesPayload('hash-original')).toBe(true);
    expect(tx.matchesPayload('hash-diferente')).toBe(false);
  });

  test('rehydrate reconstrói estado terminal sem revalidar transições', () => {
    const original = processedBet();
    const copy = WagerTransaction.rehydrate({
      ...wagerProps(),
      id: original.id,
      createdAt: original.createdAt,
      status: Status.Processed,
      processedAt: at,
      resultBalance: brl('75.00'),
    });
    expect(copy.status).toBe(Status.Processed);
    expect(copy.resultBalance?.amount).toBe('75.00');
  });
});
