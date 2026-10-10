import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import type { AppConfig } from '../../src/config';
import { Metrics } from '../../src/metrics/metrics';
import { testDatabaseUrl, testSqsOptions } from './test-env';

/** Pool maior que o paralelismo dos testes (até 50 operações simultâneas). */
export const TEST_POOL_MAX = 60;

export interface LogEntry {
  level: string;
  message: unknown;
}

/** Logger que guarda as entradas em memória para os testes verificarem o que foi logado. */
export class CapturingLogger implements LoggerService {
  readonly entries: LogEntry[] = [];
  log(message: unknown) {
    this.entries.push({ level: 'log', message });
  }
  warn(message: unknown) {
    this.entries.push({ level: 'warn', message });
  }
  error(message: unknown) {
    this.entries.push({ level: 'error', message });
  }
  debug() {}
  verbose() {}
}

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  metrics: Metrics;
  logger: CapturingLogger;
  baseUrl: string;
  close(): Promise<void>;
}

export interface TestAppOptions {
  queuePrefix?: string;
  databaseUrl?: string;
  dbQueryTimeoutMs?: number;
  dbPoolMax?: number;
  dbConnectTimeoutMs?: number;
  pendingReference?: Partial<AppConfig['pendingReference']>;
  consumer?: Partial<AppConfig['consumer']>;
  outbox?: Partial<AppConfig['outbox']>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const logger = new CapturingLogger();
  const app = await NestFactory.create(
    AppModule.forRoot({
      port: 0,
      databaseUrl: options.databaseUrl ?? testDatabaseUrl(),
      dbPoolMax: options.dbPoolMax ?? TEST_POOL_MAX,
      dbConnectTimeoutMs: options.dbConnectTimeoutMs ?? 5000,
      dbQueryTimeoutMs: options.dbQueryTimeoutMs ?? 10000,
      // Nos testes o loop automático fica desligado (os testes chamam processDue) e o backoff é curto.
      pendingReference: { workerEnabled: false, pollIntervalMs: 50, baseDelayMs: 20, maxAttempts: 3, ...options.pendingReference },
      // Consumidor e publisher desligados por padrão: os testes chamam pollOnce/publishOnce.
      consumer: {
        enabled: false,
        batchSize: 5,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 2,
        retryBaseDelaySeconds: 1,
        retryMaxDelaySeconds: 4,
        shutdownTimeoutMs: 5000,
        crashAfterCommit: false,
        ...options.consumer,
      },
      outbox: { publisherEnabled: false, pollIntervalMs: 50, batchSize: 20, ...options.outbox },
      sqs: { ...testSqsOptions(), queuePrefix: options.queuePrefix ?? '' },
    }),
    { logger },
  );
  await app.listen(0);
  const orm = app.get(MikroORM) as MikroORM;
  await orm.migrator.up();
  return {
    app,
    orm,
    metrics: app.get(Metrics),
    logger,
    baseUrl: await app.getUrl(),
    close: () => app.close(),
  };
}
