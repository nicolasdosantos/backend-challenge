import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, computePayloadHash, type WagerPayload } from '../../src/wagering/payload-hash';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('ordena chaves recursivamente, sem espaços, omitindo undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, { f: true, e: null }] }, z: undefined })).toBe(
      '{"a":{"c":[2,{"e":null,"f":true}],"d":"x"},"b":1}',
    );
  });
});

describe('computePayloadHash', () => {
  test('é o SHA-256 hex do JSON canônico dos campos de negócio', () => {
    const expected = createHash('sha256')
      .update(
        '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
          '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a",' +
          '"roundId":"round-987","walletId":"wallet-1"}',
      )
      .digest('hex');
    expect(computePayloadHash(payload)).toBe(expected);
  });

  test('independe da ordem das chaves e normaliza o amount ("25" == "25.00")', () => {
    const reordered: WagerPayload = {
      money: { currency: 'BRL', amount: '25' },
      walletId: 'wallet-1',
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test('mesmo payload → mesmo hash (determinístico)', () => {
    expect(computePayloadHash({ ...payload })).toBe(computePayloadHash(payload));
  });

  test('ignora header e metadados de transporte (idempotencyKey, correlationId, messageId, occurredAt)', () => {
    const withTransport = {
      ...payload,
      idempotencyKey: 'provider-a:transaction-123',
      correlationId: 'c',
      causationId: 'x',
      messageId: 'm',
      occurredAt: '2026-07-29T15:00:00.000Z',
    };
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload));
  });

  test.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['moeda', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['referência', { referenceExternalTransactionId: 'bet-1' }],
  ])('qualquer mudança de negócio (%s) muda o hash', (_label, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });
});
