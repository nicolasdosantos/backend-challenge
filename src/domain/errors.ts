/** Erros de domínio: violação de regra ou entrada inválida. Nunca indicam falha de infraestrutura. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {}

export class InsufficientFundsError extends DomainError {}

/** Dados de criação inválidos (vira HTTP 400 na API). */
export class InvalidWagerTransactionError extends DomainError {}

/** Tentativa de transição a partir de estado terminal: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}
