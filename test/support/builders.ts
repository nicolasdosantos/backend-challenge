import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/** Transação válida de provedor com valores padrão; sobrescreva só o que importa no teste. */
export function wagerProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${crypto.randomUUID()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    ...overrides,
  };
}

export function processedBet(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const bet = WagerTransaction.create(wagerProps({ kind: WagerTransactionKind.Bet, ...overrides }));
  bet.markProcessed(undefined, new Date(), brl('75.00'));
  return bet;
}
