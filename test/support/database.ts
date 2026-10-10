import { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import { createOrmConfig } from '../../src/database/mikro-orm.config';
import { newId } from '../../src/domain/id';
import { testDatabaseUrl } from './test-env';

/**
 * Estratégia de dados nos testes de integração: cada teste cria seus próprios registros com
 * ids novos (UUID v7) e nunca depende de tabela vazia, então não há limpeza entre testes e
 * nenhum trigger ou constraint é desligado. O reset completo, quando necessário, é feito
 * pela própria migration (down/up), como no teste de migrations.
 */
export async function createTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(createOrmConfig(testDatabaseUrl()));
  await orm.migrator.up();
  return orm;
}

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

/** Espera que o PostgreSQL recuse a operação com o SQLSTATE (e a constraint) indicados. */
export async function expectDbError(promise: Promise<unknown>, code: string, constraint?: string): Promise<PgError> {
  let error: PgError | undefined;
  try {
    await promise;
  } catch (e) {
    error = e as PgError;
  }
  expect(error, 'a operação deveria ter sido recusada pelo banco').toBeDefined();
  expect(error?.code).toBe(code);
  if (constraint) {
    expect(error?.constraint).toBe(constraint);
  }
  return error as PgError;
}

export const SQLSTATE = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  restrictViolation: '23001',
} as const;

export class Fixtures {
  constructor(private readonly orm: MikroORM) {}

  execute(sql: string, params: unknown[] = []) {
    return this.orm.em.getConnection().execute(sql, params);
  }

  async wallet(overrides: { balance?: string; currency?: string; playerId?: string } = {}) {
    const id = newId();
    await this.execute(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, 1, now(), now())`,
      [id, overrides.playerId ?? `player-${newId()}`, overrides.currency ?? 'BRL', overrides.balance ?? '100.00'],
    );
    return id;
  }

  async transaction(
    walletId: string,
    overrides: {
      kind?: string;
      status?: string;
      amount?: string;
      failureCode?: string | null;
      referenceExternalTransactionId?: string | null;
      referenceTransactionId?: string | null;
      idempotencyKey?: string;
      externalTransactionId?: string;
    } = {},
  ) {
    const id = newId();
    const externalTransactionId = overrides.externalTransactionId ?? `ext-${id}`;
    const status = overrides.status ?? 'PROCESSED';
    const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(status);
    await this.execute(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, result_balance, created_at, processed_at)
       values (?, 'provider-a', ?, ?, 'hash', ?, 'player', 'round-1', 'game', ?, ?, 'BRL', ?, ?, ?, ?, null, now(), ?)`,
      [
        id,
        externalTransactionId,
        overrides.idempotencyKey ?? `provider-a:${externalTransactionId}`,
        walletId,
        overrides.kind ?? 'BET',
        overrides.amount ?? '25.00',
        overrides.referenceExternalTransactionId ?? null,
        overrides.referenceTransactionId ?? null,
        status,
        overrides.failureCode ?? null,
        terminal ? new Date() : null,
      ],
    );
    return id;
  }

  async ledgerEntry(
    walletId: string,
    transactionId: string,
    overrides: { direction?: string; amount?: string; before?: string; after?: string; currency?: string } = {},
  ) {
    const id = newId();
    await this.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
      [
        id,
        walletId,
        transactionId,
        overrides.direction ?? 'DEBIT',
        overrides.amount ?? '25.00',
        overrides.currency ?? 'BRL',
        overrides.before ?? '100.00',
        overrides.after ?? '75.00',
      ],
    );
    return id;
  }
}
