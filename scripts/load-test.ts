/**
 * Teste de carga simples (opcional no enunciado). Pré-requisito: app rodando (`bun run start`) com o
 * compose no ar. Uso: bun run test:load [baseUrl=http://localhost:3000]
 * Configurável por env: LOAD_REQUESTS (2000), LOAD_CONCURRENCY (50), LOAD_WALLETS (20), LOAD_HOT_SHARE (0.5),
 * LOAD_REPLAY_SHARE (0.1).
 */
import { cpus, platform, release } from 'node:os';

const baseUrl = process.argv[2] ?? 'http://localhost:3000';
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 20);
const HOT_SHARE = Number(process.env.LOAD_HOT_SHARE ?? 0.5); // fração das apostas na wallet "quente"
const REPLAY_SHARE = Number(process.env.LOAD_REPLAY_SHARE ?? 0.1); // fração de reenvios com a mesma chave

async function metric(name: string): Promise<number> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  return text
    .split('\n')
    .filter((line) => line.startsWith(name) && !line.startsWith(`${name}_`))
    .reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

// 1. Wallets com saldo alto o bastante para nenhuma aposta ser rejeitada por saldo.
const wallets: { id: string; playerId: string }[] = [];
for (let i = 0; i < WALLETS; i++) {
  const playerId = `load-${crypto.randomUUID()}`;
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
  });
  const body = (await response.json()) as { id: string };
  wallets.push({ id: body.id, playerId });
}

// 2. Carga: BET de 1.00; parte vai para a wallet quente; parte reenvia uma chave já usada.
interface Planned {
  key: string;
  body: string;
}
const sent: Planned[] = [];
function nextRequest(i: number): Planned {
  if (sent.length > 0 && i % Math.max(1, Math.round(1 / REPLAY_SHARE)) === 0) {
    return sent[Math.floor(Math.random() * sent.length)] as Planned; // replay
  }
  const wallet = (Math.random() < HOT_SHARE ? wallets[0] : wallets[1 + Math.floor(Math.random() * (WALLETS - 1))]) as {
    id: string;
    playerId: string;
  };
  const externalTransactionId = `load-${crypto.randomUUID()}`;
  const planned = {
    key: `provider-load:${externalTransactionId}`,
    body: JSON.stringify({
      providerId: 'provider-load',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${i}`,
      gameId: 'load-test',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    }),
  };
  sent.push(planned);
  return planned;
}

const conflictsBefore = await metric('wallet_lock_conflicts_total');
const latencies: number[] = [];
const statuses = new Map<string, number>();
let maxOutboxLag = 0;
let next = 0;
const lagSampler = setInterval(async () => {
  maxOutboxLag = Math.max(maxOutboxLag, await metric('outbox_lag_seconds').catch(() => 0));
}, 500);

const started = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < REQUESTS) {
      const request = nextRequest(next++);
      const t0 = performance.now();
      let status: string;
      try {
        const response = await fetch(`${baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
          body: request.body,
        });
        await response.arrayBuffer();
        status = String(response.status);
      } catch {
        status = 'network_error';
      }
      latencies.push(performance.now() - t0);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
  }),
);
const elapsedSeconds = (performance.now() - started) / 1000;
clearInterval(lagSampler);

// 3. Espera a outbox esvaziar (publicador ligado) e mede o lag máximo observado.
let lagAtEnd = await metric('outbox_lag_seconds');
for (let i = 0; i < 60 && lagAtEnd > 0; i++) {
  await Bun.sleep(500);
  lagAtEnd = await metric('outbox_lag_seconds');
  maxOutboxLag = Math.max(maxOutboxLag, lagAtEnd);
}

latencies.sort((a, b) => a - b);
const errors = [...statuses.entries()].filter(([s]) => s === 'network_error' || s.startsWith('5')).reduce((n, [, c]) => n + c, 0);
const reconciliation = (await (await fetch(`${baseUrl}/wallets/${wallets[0]?.id}/reconciliation`, { method: 'POST' })).json()) as {
  consistent: boolean;
};

const report = {
  ambiente: { so: `${platform()} ${release()}`, cpus: cpus().length, bun: Bun.version, alvo: baseUrl },
  metodologia: {
    requisicoes: REQUESTS,
    concorrencia: CONCURRENCY,
    wallets: WALLETS,
    fracaoNaWalletQuente: HOT_SHARE,
    fracaoDeReenvios: REPLAY_SHARE,
    operacao: 'POST /wagering/transactions, BET de 1.00',
  },
  resultados: {
    duracaoSegundos: Number(elapsedSeconds.toFixed(2)),
    throughputReqPorSegundo: Number((REQUESTS / elapsedSeconds).toFixed(1)),
    latenciaMs: {
      p50: Number(percentile(latencies, 50).toFixed(1)),
      p95: Number(percentile(latencies, 95).toFixed(1)),
      p99: Number(percentile(latencies, 99).toFixed(1)),
      max: Number((latencies.at(-1) ?? 0).toFixed(1)),
    },
    statusHttp: Object.fromEntries(statuses),
    taxaDeErro: Number((errors / REQUESTS).toFixed(4)),
    conflitosDeLock: (await metric('wallet_lock_conflicts_total')) - conflictsBefore,
    outboxLagMaximoSegundos: Number(maxOutboxLag.toFixed(2)),
    outboxLagAoFinalSegundos: Number(lagAtEnd.toFixed(2)),
    walletQuenteConsistente: reconciliation.consistent,
  },
};
console.log(JSON.stringify(report, null, 2));
