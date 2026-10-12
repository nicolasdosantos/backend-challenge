// Configuração do MikroORM (PostgreSQL): entidades, pool, timeouts do driver `pg` e migrations.
// Usada pela app (AppModule) e pelo CLI do MikroORM (export default no fim do arquivo).

import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { join } from 'node:path';
import { ALL_SCHEMAS } from './records';

export interface DatabaseOptions {
  poolMax?: number;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export function createOrmConfig(databaseUrl: string, options: DatabaseOptions = {}): Options {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: ALL_SCHEMAS,
    // Cada operação concorrente segura uma conexão durante a transação (inclusive esperando o lock).
    pool: { min: 0, max: options.poolMax ?? 10 },
    // Repassado ao Pool do `pg`: sem resposta do banco, a operação falha (→ 503) em vez de travar.
    // connectionTimeoutMillis também limita a espera por uma conexão livre do pool.
    driverOptions: {
      connectionTimeoutMillis: options.connectTimeoutMs ?? 5000,
      query_timeout: options.queryTimeoutMs ?? 10000,
    },
    extensions: [Migrator],
    migrations: {
      path: join(import.meta.dir, 'migrations'),
      pathTs: join(import.meta.dir, 'migrations'),
      // cada migration roda em transação; com allOrNothing, as pendentes entram todas juntas ou nenhuma
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}

// Usado pelo CLI do MikroORM (bun --bun mikro-orm ...).
export default createOrmConfig(process.env.DATABASE_URL ?? '');
