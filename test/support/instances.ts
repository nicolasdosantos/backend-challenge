import type { Subprocess } from 'bun';
import { join } from 'node:path';
import { testDatabaseUrl, testSqsOptions } from './test-env';

const PROJECT_ROOT = join(import.meta.dir, '..', '..');

export interface Instance {
  port: number;
  url: string;
  process: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** stdout acumulado (logs JSON da aplicação). */
  output(): string;
}

/**
 * Sobe um processo real da aplicação (`bun run src/main.ts`) apontando para o banco de teste e
 * para as filas com o prefixo do teste. Tudo o que não for passado em `env` usa padrões de teste.
 */
export async function startInstance(port: number, queuePrefix: string, env: Record<string, string> = {}): Promise<Instance> {
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl(),
      DB_POOL_MAX: '20',
      SQS_ENDPOINT: testSqsOptions().endpoint,
      SQS_QUEUE_PREFIX: queuePrefix,
      SQS_CONSUMER_ENABLED: 'false',
      SQS_CONSUMER_WAIT_TIME_SECONDS: '1',
      SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '2',
      SQS_CONSUMER_RETRY_BASE_DELAY_SECONDS: '1',
      OUTBOX_PUBLISHER_ENABLED: 'false',
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_WORKER_ENABLED: 'false',
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let output = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout) output += decoder.decode(chunk);
  })();
  void (async () => {
    for await (const chunk of proc.stderr) output += decoder.decode(chunk);
  })();

  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (proc.exitCode !== null) {
      throw new Error(`instance on port ${port} exited during startup:\n${output}`);
    }
    try {
      if ((await fetch(`${url}/health/live`)).ok) return { port, url, process: proc, output: () => output };
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  proc.kill('SIGKILL');
  throw new Error(`instance on port ${port} did not start:\n${output}`);
}

/** Lê uma métrica (soma de todas as séries com esse nome e os labels dados) do /metrics de uma instância. */
export async function scrapeMetric(instance: Instance, name: string, labels: Record<string, string> = {}): Promise<number> {
  const text = await (await fetch(`${instance.url}/metrics`)).text();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const matches = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (matches) total += Number(line.split(' ').at(-1));
  }
  return total;
}
