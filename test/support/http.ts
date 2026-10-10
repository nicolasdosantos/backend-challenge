import type { ProcessWagerTransactionCommand } from '../../src/wagering/process-wager-transaction';

/** POST /wagering/transactions com a chave no header; o resto do comando vai no corpo. */
export async function submitTransaction(
  baseUrl: string,
  command: ProcessWagerTransactionCommand,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { idempotencyKey, correlationId, causationId: _causationId, ...body } = command;
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-correlation-id': correlationId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
