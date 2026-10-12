// Leitura e validação da mensagem WagerTransactionRequested recebida pela fila. Qualquer erro aqui é
// permanente (InvalidMessageError com motivo): a mensagem vai direto para a DLQ.

import { InvalidRequestError } from '../application-errors';
import type { ProcessWagerTransactionCommand } from '../wagering/process-wager-transaction';
import { parseWagerPayload } from '../wagering/wager-payload';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/** Motivos estáveis de envio à DLQ (vão em log, métrica e atributo da mensagem na DLQ). */
export type DeadLetterReason =
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'INVALID_PAYLOAD'
  | 'WALLET_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'DUPLICATE_EXTERNAL_TRANSACTION'
  | 'INBOX_PAYLOAD_CONFLICT'
  | 'PROCESSING_FAILED';

/** Mensagem que nunca vai poder ser processada como está (erro permanente → DLQ). */
export class InvalidMessageError extends Error {
  constructor(
    readonly reason: DeadLetterReason,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

export interface WagerMessage {
  messageId: string;
  occurredAt: string;
  command: ProcessWagerTransactionCommand;
}

/**
 * Valida o envelope do enunciado (§10) e o `data`. O `messageId` vira correlationId/causationId,
 * mas NÃO entra no payloadHash (que é calculado só sobre os campos de negócio).
 */
export function parseWagerMessage(body: string): WagerMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('INVALID_JSON', 'Message body is not valid JSON');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new InvalidMessageError('INVALID_ENVELOPE', 'Message body must be a JSON object');
  }
  const e = envelope as Record<string, unknown>;
  if (typeof e.messageId !== 'string' || e.messageId.length === 0) {
    throw new InvalidMessageError('INVALID_ENVELOPE', 'messageId must be a non-empty string');
  }
  if (e.type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidMessageError('UNKNOWN_MESSAGE_TYPE', `Unsupported message type ${String(e.type)}`);
  }
  if (typeof e.occurredAt !== 'string' || Number.isNaN(Date.parse(e.occurredAt))) {
    throw new InvalidMessageError('INVALID_ENVELOPE', 'occurredAt must be an ISO-8601 date');
  }
  const data = e.data as Record<string, unknown> | undefined;
  if (typeof data?.idempotencyKey !== 'string' || data.idempotencyKey.length === 0) {
    throw new InvalidMessageError('INVALID_ENVELOPE', 'data.idempotencyKey must be a non-empty string');
  }

  let payload;
  try {
    payload = parseWagerPayload(data);
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      throw new InvalidMessageError('INVALID_PAYLOAD', error.message);
    }
    throw error;
  }
  return {
    messageId: e.messageId,
    occurredAt: e.occurredAt,
    command: { ...payload, idempotencyKey: data.idempotencyKey, correlationId: e.messageId, causationId: e.messageId },
  };
}
