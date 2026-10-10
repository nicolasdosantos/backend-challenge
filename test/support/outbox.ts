import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * O banco de teste acumula eventos não publicados de outros arquivos de teste (que não rodam o
 * publisher). Eles não fazem parte dos cenários de publicação, então são marcados como publicados
 * antes do arquivo começar. Só no banco de teste; outbox_messages não tem trigger.
 */
export async function discardForeignOutboxBacklog(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().execute(`update outbox_messages set published_at = now() where published_at is null`);
}

export async function unpublishedFor(orm: MikroORM, walletIds: string[]): Promise<number> {
  const [row] = await orm.em
    .getConnection()
    .execute<{ count: number }[]>(
      `select count(*)::int as count from outbox_messages where aggregate_id in (?) and published_at is null`,
      [walletIds],
    );
  return row?.count ?? 0;
}

export async function outboxIdsFor(orm: MikroORM, walletIds: string[]): Promise<string[]> {
  const rows = await orm.em
    .getConnection()
    .execute<{ id: string }[]>(`select id from outbox_messages where aggregate_id in (?) order by id`, [walletIds]);
  return rows.map((r) => r.id);
}
