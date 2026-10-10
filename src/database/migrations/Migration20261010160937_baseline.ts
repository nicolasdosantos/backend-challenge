import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade ficam no banco
 * (enunciado §5.9), não apenas no código.
 */
export class Migration20261010160937_baseline extends Migration {
  override name = 'Migration20261010160937_baseline';

  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency_unique unique (player_id, currency),
        -- alvo da FK composta do ledger (garante que o lançamento tem a moeda da wallet)
        constraint wallets_id_currency_unique unique (id, currency)
      );`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null,
        failure_code text,
        result_balance numeric(20,2),
        created_at timestamptz not null,
        processed_at timestamptz,
        -- reprocessamento de PENDING_REFERENCE (backoff exponencial)
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_valid
          check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_reversal_requires_reference
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_allowed
          check (kind not in ('OPENING', 'BET') or reference_external_transaction_id is null),
        constraint wager_transactions_failure_code_matches_status
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_terminal_has_processed_at
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint wager_transactions_reference_attempts_non_negative check (reference_attempts >= 0),
        -- só (e sempre) uma transação aguardando referência tem próxima tentativa agendada
        constraint wager_transactions_pending_reference_scheduled
          check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null))
      );`);

    // Regra 7.4 (leitura estrita): uma transação aceita no máximo UMA reversão processada,
    // seja REFUND ou ROLLBACK. Reversões rejeitadas não contam.
    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';`);
    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';`);
    // Resolução de referência: (provider_id, external_transaction_id) já é coberto pela unique.

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        -- ordem de inserção: lançamentos da mesma wallet são serializados pelo lock da wallet,
        -- então a ordem do seq é a ordem de commit, sem depender do relógio das instâncias
        seq bigint generated always as identity,
        wallet_id uuid not null,
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_seq_unique unique (seq),
        constraint wallet_ledger_entries_one_per_transaction unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );`);
    // Paginação por cursor do ledger: keyset em (wallet_id, seq).
    this.addSql(`create index wallet_ledger_entries_wallet_cursor on wallet_ledger_entries (wallet_id, seq);`);

    // Imutabilidade estrutural do ledger: UPDATE, DELETE e TRUNCATE são recusados pelo banco.
    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;`);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only();`);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only();`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz
      );`);
    this.addSql(`
      create index outbox_messages_pending
        on outbox_messages (occurred_at)
        where published_at is null;`);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop function if exists wallet_ledger_entries_append_only();`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
  }
}
