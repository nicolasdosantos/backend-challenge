import { describe, expect, test } from 'bun:test';
import { nextReferenceAttemptAt, referenceRetriesExhausted } from '../../src/wagering/reference-retry-policy';

const policy = { baseDelayMs: 2000, maxAttempts: 6 };
const now = new Date('2026-10-10T12:00:00Z');

describe('política de backoff do PENDING_REFERENCE', () => {
  test('atrasos 2s, 4s, 8s, 16s, 32s, 64s (~126s de janela)', () => {
    const delays = [0, 1, 2, 3, 4, 5].map((attempts) => nextReferenceAttemptAt(policy, attempts, now).getTime() - now.getTime());
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 64000]);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(126_000);
  });

  test('esgota na 6ª reavaliação', () => {
    expect([0, 1, 2, 3, 4].map((a) => referenceRetriesExhausted(policy, a))).toEqual([false, false, false, false, false]);
    expect(referenceRetriesExhausted(policy, 5)).toBe(true);
  });
});
