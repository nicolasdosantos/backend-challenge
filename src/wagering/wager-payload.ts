import { InvalidRequestError } from '../application-errors';
import type { WagerPayload } from './payload-hash';

const REQUIRED_STRING_FIELDS = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind'] as const;

/**
 * Valida a forma dos campos de negócio de uma transação, venha ela do corpo HTTP ou do `data`
 * de uma mensagem SQS. Só copia os campos conhecidos: o resto (transporte, extras) é ignorado.
 */
export function parseWagerPayload(value: unknown): WagerPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError('Payload must be a JSON object');
  }
  const b = value as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof b[field] !== 'string') {
      throw new InvalidRequestError(`${field} must be a string`);
    }
  }
  const money = b.money as Record<string, unknown> | undefined;
  if (typeof money?.amount !== 'string' || typeof money.currency !== 'string') {
    throw new InvalidRequestError('money must be { amount: string, currency: string }');
  }
  if (b.referenceExternalTransactionId !== undefined && typeof b.referenceExternalTransactionId !== 'string') {
    throw new InvalidRequestError('referenceExternalTransactionId must be a string');
  }
  const fields = Object.fromEntries(REQUIRED_STRING_FIELDS.map((f) => [f, b[f]])) as Omit<WagerPayload, 'money'>;
  return {
    ...fields,
    money: { amount: money.amount, currency: money.currency },
    ...(b.referenceExternalTransactionId !== undefined && {
      referenceExternalTransactionId: b.referenceExternalTransactionId as string,
    }),
  };
}
