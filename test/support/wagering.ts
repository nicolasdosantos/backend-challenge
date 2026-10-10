import { newId } from '../../src/domain/id';
import type { ProcessWagerTransactionCommand } from '../../src/wagering/process-wager-transaction';
import { CreateWallet } from '../../src/wallets/create-wallet';
import type { TestApp } from './app';

export interface TestWallet {
  id: string;
  playerId: string;
}

export async function openWallet(t: TestApp, amount: string, currency = 'BRL'): Promise<TestWallet> {
  const playerId = `player-${newId()}`;
  const wallet = await t.app.get(CreateWallet).execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: `test-${newId()}`,
  });
  return { id: wallet.id, playerId };
}

/** Comando de BET válido para a wallet; cada chamada gera um externalTransactionId (e chave) novo. */
export function wagerCommand(
  wallet: TestWallet,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${newId()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${newId()}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: `corr-${newId()}`,
    ...overrides,
  };
}
