import { describe, expect, test } from 'bun:test';
import { InvalidRequestError } from '../../src/application-errors';
import { parseSubmitRequest } from '../../src/wagering/wagering.controller';
import { decodeCursor, encodeCursor, parseLimit } from '../../src/wallets/wallet-queries';

const body = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('parseSubmitRequest', () => {
  test('o header Idempotency-Key vira o idempotencyKey do comando', () => {
    const command = parseSubmitRequest(body, 'provider-a:transaction-123', 'corr-1');
    expect(command).toEqual({ ...body, idempotencyKey: 'provider-a:transaction-123', correlationId: 'corr-1' });
  });

  test('header ausente → erro de payload inválido', () => {
    expect(() => parseSubmitRequest(body, undefined, undefined)).toThrow(InvalidRequestError);
    expect(() => parseSubmitRequest(body, '', undefined)).toThrow(InvalidRequestError);
  });

  test('chave no corpo diferente do header → erro; igual ao header → aceito', () => {
    expect(() => parseSubmitRequest({ ...body, idempotencyKey: 'other' }, 'k', undefined)).toThrow(InvalidRequestError);
    expect(parseSubmitRequest({ ...body, idempotencyKey: 'k' }, 'k', undefined).idempotencyKey).toBe('k');
  });

  test.each([
    ['campo ausente', { ...body, roundId: undefined }],
    ['campo com tipo errado', { ...body, walletId: 123 }],
    ['money sem currency', { ...body, money: { amount: '1.00' } }],
    ['amount como number', { ...body, money: { amount: 1, currency: 'BRL' } }],
    ['referência não-string', { ...body, referenceExternalTransactionId: 7 }],
    ['corpo não-objeto', [body]],
  ])('%s → erro', (_label, invalid) => {
    expect(() => parseSubmitRequest(invalid, 'k', undefined)).toThrow(InvalidRequestError);
  });

  test('campos extras são ignorados e não chegam ao comando', () => {
    const command = parseSubmitRequest({ ...body, messageId: 'm', extra: true }, 'k', undefined);
    expect(command).not.toHaveProperty('messageId');
    expect(command).not.toHaveProperty('extra');
  });
});

describe('cursor do ledger', () => {
  test('é opaco (base64url) e volta igual', () => {
    const cursor = { seq: '12345' };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  test.each([
    'not base64 !!',
    Buffer.from('not json').toString('base64url'),
    Buffer.from('{}').toString('base64url'),
    Buffer.from('{"seq":12}').toString('base64url'),
    Buffer.from('{"seq":"0"}').toString('base64url'),
    Buffer.from('{"seq":"-1"}').toString('base64url'),
    Buffer.from('{"seq":"1 or 1=1"}').toString('base64url'),
    Buffer.from('{"seq":"99999999999999999999"}').toString('base64url'),
  ])('cursor inválido %s → erro', (raw) => {
    expect(() => decodeCursor(raw)).toThrow(InvalidRequestError);
  });

  test('limit: padrão 50, máximo 100, inteiro positivo', () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit('100')).toBe(100);
    for (const invalid of ['0', '101', '-1', '1.5', 'abc', '']) {
      expect(() => parseLimit(invalid)).toThrow(InvalidRequestError);
    }
  });
});
