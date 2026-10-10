/**
 * Os testes podem apagar dados livremente, então só rodam contra um banco cujo nome termina em `_test`.
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL não definida para os testes');
  }
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Recusando rodar testes contra o banco "${databaseName}" (precisa terminar em _test)`);
  }
  return url;
}

export function testSqsOptions() {
  return {
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
  };
}

/** Prefixo único por execução para as filas de teste não interferirem nas filas reais nem entre si. */
export function uniqueQueuePrefix(): string {
  return `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-`;
}
