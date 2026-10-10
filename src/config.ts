export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  /** Timeouts do lado do cliente: banco que não responde vira erro (HTTP 503) em vez de travar a requisição. */
  dbConnectTimeoutMs: number;
  dbQueryTimeoutMs: number;
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
    sqs: {
      endpoint: env.SQS_ENDPOINT,
      region: env.AWS_REGION ?? 'us-east-1',
      queuePrefix: env.SQS_QUEUE_PREFIX ?? '',
    },
  };
}
