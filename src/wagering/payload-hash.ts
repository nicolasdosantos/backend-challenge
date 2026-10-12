// payloadHash da idempotência: a mesma função para a API e para a fila, então os dois caminhos geram o mesmo hash.

import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../domain/money';

/** Campos de negócio de uma transação submetida. Header e metadados de transporte não entram. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** JSON com chaves ordenadas recursivamente e sem espaços; campos undefined são omitidos. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      // comparação simples de string (por code unit), não localeCompare: a ordem não depende do idioma da máquina
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 (hex) do JSON canônico dos campos de negócio. O amount é normalizado pelo Money
 * ("25" e "25.00" geram o mesmo hash); campos extras do objeto recebido são ignorados.
 */
export function computePayloadHash(payload: WagerPayload): string {
  const business = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}
