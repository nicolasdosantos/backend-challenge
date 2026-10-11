// Política de reprocessamento de PENDING_REFERENCE: funções puras, sem banco, fáceis de testar.

/** Backoff exponencial do reprocessamento de PENDING_REFERENCE. */
export interface ReferenceRetryPolicy {
  baseDelayMs: number;
  maxAttempts: number;
}

/**
 * Instante da próxima reavaliação: base × 2^tentativas já feitas.
 * Com base 2s: 2s, 4s, 8s, 16s, 32s, 64s → ~126s de janela para 6 tentativas.
 */
export function nextReferenceAttemptAt(policy: ReferenceRetryPolicy, attemptsSoFar: number, now: Date): Date {
  return new Date(now.getTime() + policy.baseDelayMs * 2 ** attemptsSoFar);
}

/** Esgotou: a próxima reavaliação ultrapassaria o limite de tentativas. */
export function referenceRetriesExhausted(policy: ReferenceRetryPolicy, attemptsSoFar: number): boolean {
  return attemptsSoFar + 1 >= policy.maxAttempts;
}
