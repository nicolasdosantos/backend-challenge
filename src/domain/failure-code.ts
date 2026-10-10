/**
 * Códigos estáveis e legíveis por máquina gravados em transações REJECTED ou FAILED.
 * A orientação ao provedor (reenviar, corrigir ou desistir) está em ARCHITECTURE.md.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AmountMismatch = 'AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  InternalError = 'INTERNAL_ERROR',
}
