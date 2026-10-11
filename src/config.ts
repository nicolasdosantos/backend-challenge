export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  /** Timeouts do lado do cliente: banco que não responde vira erro (HTTP 503) em vez de travar a requisição. */
  dbConnectTimeoutMs: number;
  dbQueryTimeoutMs: number;
  pendingReference: {
    /** Loop agendado que reavalia transações em PENDING_REFERENCE. */
    workerEnabled: boolean;
    pollIntervalMs: number;
    /** Atraso da 1ª reavaliação; dobra a cada tentativa (2s, 4s, 8s, ...). */
    baseDelayMs: number;
    /** Reavaliações antes de desistir (6 → janela de ~2 min com base de 2s). */
    maxAttempts: number;
  };
  consumer: {
    /** Consumidor da fila wager-transactions.fifo (pode ser desligado por instância). */
    enabled: boolean;
    batchSize: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    /** Backoff de erro transitório (segundos): base × 2^(receiveCount-1), limitado ao máximo. */
    retryBaseDelaySeconds: number;
    retryMaxDelaySeconds: number;
    /** Igual ao maxReceiveCount da redrive policy: identifica a última tentativa antes da DLQ. */
    maxReceiveCount: number;
    /** No SIGTERM, quanto esperar a mensagem em andamento antes de seguir com o shutdown. */
    shutdownTimeoutMs: number;
    /** RECURSO DE TESTE: encerra o processo logo após o commit e antes do ack (FAULT_CRASH_AFTER_COMMIT=1). */
    crashAfterCommit: boolean;
  };
  outbox: {
    /** Publicador da outbox na fila wallet-events.fifo. */
    publisherEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
  };
  sqs: {
    endpoint: string | undefined;
    region: string;
    queuePrefix: string;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    dbPoolMax: Number(env.DB_POOL_MAX ?? 10),
    dbConnectTimeoutMs: Number(env.DB_CONNECT_TIMEOUT_MS ?? 5000),
    dbQueryTimeoutMs: Number(env.DB_QUERY_TIMEOUT_MS ?? 10000),
    pendingReference: {
      workerEnabled: (env.PENDING_REFERENCE_WORKER_ENABLED ?? 'true') === 'true',
      pollIntervalMs: Number(env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1000),
      baseDelayMs: Number(env.PENDING_REFERENCE_BASE_DELAY_MS ?? 2000),
      maxAttempts: Number(env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 6),
    },
    consumer: {
      enabled: (env.SQS_CONSUMER_ENABLED ?? 'true') === 'true',
      batchSize: Number(env.SQS_CONSUMER_BATCH_SIZE ?? 5),
      waitTimeSeconds: Number(env.SQS_CONSUMER_WAIT_TIME_SECONDS ?? 10),
      visibilityTimeoutSeconds: Number(env.SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS ?? 30),
      retryBaseDelaySeconds: Number(env.SQS_CONSUMER_RETRY_BASE_DELAY_SECONDS ?? 2),
      retryMaxDelaySeconds: Number(env.SQS_CONSUMER_RETRY_MAX_DELAY_SECONDS ?? 60),
      maxReceiveCount: Number(env.SQS_CONSUMER_MAX_RECEIVE_COUNT ?? 5),
      shutdownTimeoutMs: Number(env.SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS ?? 10000),
      crashAfterCommit: env.FAULT_CRASH_AFTER_COMMIT === '1',
    },
    outbox: {
      publisherEnabled: (env.OUTBOX_PUBLISHER_ENABLED ?? 'true') === 'true',
      pollIntervalMs: Number(env.OUTBOX_POLL_INTERVAL_MS ?? 500),
      batchSize: Number(env.OUTBOX_BATCH_SIZE ?? 20),
    },
    sqs: {
      endpoint: env.SQS_ENDPOINT,
      region: env.AWS_REGION ?? 'us-east-1',
      queuePrefix: env.SQS_QUEUE_PREFIX ?? '',
    },
  };
}
