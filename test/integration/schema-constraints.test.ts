import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '../../src/domain/id';
import { createTestOrm, expectDbError, Fixtures, SQLSTATE } from '../support/database';

/** Prova que as garantias do §5.9 estão no schema: as operações aqui vão direto ao SQL, sem o domínio. */
let orm: MikroORM;
let db: Fixtures;

beforeAll(async () => {
  orm = await createTestOrm();
  db = new Fixtures(orm);
});

afterAll(async () => {
  await orm.close();
});

describe('wallets', () => {
  test('saldo negativo é recusado na inserção e na atualização', async () => {
    await expectDbError(db.wallet({ balance: '-0.01' }), SQLSTATE.checkViolation, 'wallets_balance_non_negative');

    const walletId = await db.wallet({ balance: '10.00' });
    await expectDbError(
      db.execute(`update wallets set balance = balance - 10.01 where id = ?`, [walletId]),
      SQLSTATE.checkViolation,
      'wallets_balance_non_negative',
    );
  });

  test('no máximo uma wallet por playerId + currency', async () => {
    const playerId = `player-${newId()}`;
    await db.wallet({ playerId, currency: 'BRL' });
    await db.wallet({ playerId, currency: 'USD' });
    await expectDbError(db.wallet({ playerId, currency: 'BRL' }), SQLSTATE.uniqueViolation, 'wallets_player_currency_unique');
  });

  test('version começa em pelo menos 1 e moeda segue o formato ISO-4217', async () => {
    const walletId = await db.wallet();
    await expectDbError(
      db.execute(`update wallets set version = 0 where id = ?`, [walletId]),
      SQLSTATE.checkViolation,
      'wallets_version_positive',
    );
    await expectDbError(db.wallet({ currency: 'brl' }), SQLSTATE.checkViolation);
  });
});

describe('wager_transactions', () => {
  test('idempotency key é única', async () => {
    const walletId = await db.wallet();
    const key = `key-${newId()}`;
    await db.transaction(walletId, { idempotencyKey: key });
    await expectDbError(
      db.transaction(walletId, { idempotencyKey: key }),
      SQLSTATE.uniqueViolation,
      'wager_transactions_idempotency_key_unique',
    );
  });

  test('(providerId, externalTransactionId) é único mesmo com outra idempotency key', async () => {
    const walletId = await db.wallet();
    const externalTransactionId = `ext-${newId()}`;
    await db.transaction(walletId, { externalTransactionId, idempotencyKey: `a-${newId()}` });
    await expectDbError(
      db.transaction(walletId, { externalTransactionId, idempotencyKey: `b-${newId()}` }),
      SQLSTATE.uniqueViolation,
      'wager_transactions_provider_external_unique',
    );
  });

  test('REFUND e ROLLBACK exigem referência; BET e OPENING não aceitam', async () => {
    const walletId = await db.wallet();
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectDbError(
        db.transaction(walletId, { kind }),
        SQLSTATE.checkViolation,
        'wager_transactions_reversal_requires_reference',
      );
    }
    for (const kind of ['BET', 'OPENING']) {
      await expectDbError(
        db.transaction(walletId, { kind, referenceExternalTransactionId: 'x' }),
        SQLSTATE.checkViolation,
        'wager_transactions_reference_allowed',
      );
    }
  });

  test('valor zero só em LOSS; kind e status fora do enum são recusados', async () => {
    const walletId = await db.wallet();
    await db.transaction(walletId, { kind: 'LOSS', amount: '0.00' });
    await expectDbError(db.transaction(walletId, { kind: 'BET', amount: '0.00' }), SQLSTATE.checkViolation, 'wager_transactions_amount_valid');
    await expectDbError(db.transaction(walletId, { kind: 'JACKPOT' }), SQLSTATE.checkViolation, 'wager_transactions_kind_valid');
    await expectDbError(db.transaction(walletId, { status: 'DONE' }), SQLSTATE.checkViolation, 'wager_transactions_status_valid');
  });

  test('REJECTED/FAILED exigem failureCode, e só eles podem tê-lo', async () => {
    const walletId = await db.wallet();
    await expectDbError(
      db.transaction(walletId, { status: 'REJECTED' }),
      SQLSTATE.checkViolation,
      'wager_transactions_failure_code_matches_status',
    );
    await expectDbError(
      db.transaction(walletId, { status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' }),
      SQLSTATE.checkViolation,
      'wager_transactions_failure_code_matches_status',
    );
    await db.transaction(walletId, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('uma referência aceita no máximo UMA reversão processada (REFUND ou ROLLBACK)', async () => {
    const walletId = await db.wallet();
    const betId = await db.transaction(walletId, { kind: 'BET' });
    const reversal = (kind: string, status = 'PROCESSED') =>
      db.transaction(walletId, {
        kind,
        status,
        failureCode: status === 'REJECTED' ? 'REVERSAL_INSUFFICIENT_FUNDS' : null,
        referenceExternalTransactionId: 'bet-ext',
        referenceTransactionId: betId,
      });

    await reversal('REFUND', 'REJECTED'); // reversão rejeitada não conta
    const refundId = await reversal('REFUND');
    await expectDbError(reversal('REFUND'), SQLSTATE.uniqueViolation, 'wager_transactions_single_reversal');
    await expectDbError(reversal('ROLLBACK'), SQLSTATE.uniqueViolation, 'wager_transactions_single_reversal');

    // ROLLBACK do REFUND é permitido: a referência é outra transação.
    await db.transaction(walletId, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'refund-ext',
      referenceTransactionId: refundId,
    });
  });
});

describe('wallet_ledger_entries', () => {
  async function walletWithEntry() {
    const walletId = await db.wallet({ balance: '75.00' });
    const transactionId = await db.transaction(walletId);
    const entryId = await db.ledgerEntry(walletId, transactionId);
    return { walletId, transactionId, entryId };
  }

  test('UPDATE é recusado pelo trigger', async () => {
    const { entryId } = await walletWithEntry();
    const error = await expectDbError(
      db.execute(`update wallet_ledger_entries set amount = 1 where id = ?`, [entryId]),
      SQLSTATE.restrictViolation,
    );
    expect(error.message).toContain('append-only: UPDATE is not allowed');
  });

  test('DELETE é recusado pelo trigger', async () => {
    const { entryId } = await walletWithEntry();
    const error = await expectDbError(
      db.execute(`delete from wallet_ledger_entries where id = ?`, [entryId]),
      SQLSTATE.restrictViolation,
    );
    expect(error.message).toContain('append-only: DELETE is not allowed');
  });

  test('TRUNCATE é recusado, inclusive via cascade a partir de wallets', async () => {
    const { entryId } = await walletWithEntry();
    await expectDbError(db.execute(`truncate wallet_ledger_entries`), SQLSTATE.restrictViolation);
    await expectDbError(db.execute(`truncate wallets cascade`), SQLSTATE.restrictViolation);

    const [row] = await db.execute(`select count(*)::int as count from wallet_ledger_entries where id = ?`, [entryId]);
    expect(row).toEqual({ count: 1 });
  });

  test('lançamento com aritmética inconsistente é recusado', async () => {
    const walletId = await db.wallet();
    const transactionId = await db.transaction(walletId);
    await expectDbError(
      db.ledgerEntry(walletId, transactionId, { before: '100.00', after: '80.00', amount: '25.00' }),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_balanced',
    );
    await expectDbError(
      db.ledgerEntry(walletId, transactionId, { direction: 'CREDIT', before: '100.00', after: '75.00' }),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_balanced',
    );
  });

  test('lançamento não pode deixar saldo negativo nem ter valor zero', async () => {
    const walletId = await db.wallet();
    const transactionId = await db.transaction(walletId);
    await expectDbError(
      db.ledgerEntry(walletId, transactionId, { before: '10.00', after: '-15.00' }),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_balances_non_negative',
    );
    await expectDbError(
      db.ledgerEntry(walletId, transactionId, { amount: '0.00', before: '10.00', after: '10.00' }),
      SQLSTATE.checkViolation,
      'wallet_ledger_entries_amount_positive',
    );
  });

  test('no máximo um lançamento por transação e wallet', async () => {
    const { walletId, transactionId } = await walletWithEntry();
    await expectDbError(
      db.ledgerEntry(walletId, transactionId, { before: '75.00', after: '50.00' }),
      SQLSTATE.uniqueViolation,
      'wallet_ledger_entries_one_per_transaction',
    );
  });

  test('a moeda do lançamento precisa ser a moeda da wallet', async () => {
    const walletId = await db.wallet({ currency: 'BRL' });
    const transactionId = await db.transaction(walletId);
    await expectDbError(
      db.ledgerEntry(walletId, transactionId, { currency: 'USD' }),
      SQLSTATE.foreignKeyViolation,
      'wallet_ledger_entries_wallet_currency_fk',
    );
  });
});

describe('inbox_messages', () => {
  test('(consumer_name, message_id) é único; ON CONFLICT DO NOTHING identifica a duplicata', async () => {
    const messageId = `msg-${newId()}`;
    const insert = () =>
      db.execute(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
         values ('wager-consumer', ?, 'h', now())
         on conflict do nothing
         returning message_id`,
        [messageId],
      );
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);

    // o mesmo messageId em outro consumidor é outra entrada
    await db.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('other-consumer', ?, 'h', now())`,
      [messageId],
    );
  });
});

describe('outbox_messages', () => {
  test('payload é jsonb e attempts não pode ser negativo', async () => {
    const id = newId();
    await db.execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values (?, 'w1', 'WalletBalanceChanged', ?, now())`,
      [id, JSON.stringify({ data: { money: { amount: '25.00', currency: 'BRL' } } })],
    );
    const [row] = await db.execute(`select payload->'data'->'money'->>'amount' as amount, attempts from outbox_messages where id = ?`, [id]);
    expect(row).toEqual({ amount: '25.00', attempts: 0 });

    await expectDbError(db.execute(`update outbox_messages set attempts = -1 where id = ?`, [id]), SQLSTATE.checkViolation);
  });
});
