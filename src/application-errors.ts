/** Erros da camada de aplicação (não são regras de domínio). O mapeamento HTTP fica em http-exception.filter.ts. */

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
    this.name = 'WalletNotFoundError';
  }
}

export class TransactionNotFoundError extends Error {
  constructor(description: string) {
    super(`Transaction ${description} not found`);
    this.name = 'TransactionNotFoundError';
  }
}

export class DuplicateWalletError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
    this.name = 'DuplicateWalletError';
  }
}

/** Mesma Idempotency-Key com payload diferente: conflito, não replay. */
export class IdempotencyKeyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Idempotency-Key ${idempotencyKey} was already used with a different payload`);
    this.name = 'IdempotencyKeyConflictError';
  }
}

/** Mesmo (providerId, externalTransactionId) já registrado com outra Idempotency-Key. */
export class DuplicateExternalTransactionError extends Error {
  constructor(providerId: string, externalTransactionId: string) {
    super(`Transaction ${externalTransactionId} of provider ${providerId} was already submitted with another key`);
    this.name = 'DuplicateExternalTransactionError';
  }
}

/** Requisição malformada (campos ausentes ou com tipo errado). */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/** Funcionalidade prevista mas ainda não implementada nesta fase (ex.: resolução de referência). */
export class NotSupportedYetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSupportedYetError';
  }
}
