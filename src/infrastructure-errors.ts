import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';

/** Códigos de erro de rede (Node) e SQLSTATE do PostgreSQL que indicam indisponibilidade passageira. */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

// Mensagens do driver `pg` para timeouts do lado do cliente (query_timeout / connectionTimeoutMillis).
const TRANSIENT_MESSAGES = ['Query read timeout', 'timeout exceeded when trying to connect', 'Connection terminated'];

/**
 * Falha transitória de infraestrutura (banco fora do ar, timeout, deadlock): pode ser reenviada.
 * É a diferença entre 503 (retryable) e 500 (erro inesperado) na API, e entre retry e DLQ no consumidor SQS.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) {
    return true;
  }
  if (TRANSIENT_MESSAGES.some((m) => error.message.includes(m))) {
    return true;
  }
  // O MikroORM embrulha o erro original do driver em `cause` em alguns caminhos.
  return error.cause !== undefined && error.cause !== error && isTransientInfrastructureError(error.cause);
}
