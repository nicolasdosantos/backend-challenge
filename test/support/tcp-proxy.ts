import type { Socket, TCPSocketListener } from 'bun';

interface Pair {
  client: Socket<Pair>;
  upstream?: Socket<Pair>;
  /** Bytes do cliente que chegaram antes da conexão com o PostgreSQL abrir. */
  pending: Uint8Array[];
}

/**
 * Proxy TCP de teste entre a aplicação e o PostgreSQL, para simular indisponibilidade de dentro
 * do container de testes (onde não há `docker pause`). Em `blackhole`, os bytes são descartados:
 * as consultas ficam sem resposta, como com o container pausado.
 */
export class TcpProxy {
  private listener?: TCPSocketListener<Pair>;
  private readonly pairs = new Set<Pair>();
  private blackhole = false;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  get port(): number {
    if (!this.listener) throw new Error('proxy not started');
    return this.listener.port;
  }

  start(): void {
    this.listener = Bun.listen<Pair>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: (client) => {
          const pair: Pair = { client, pending: [] };
          client.data = pair;
          this.pairs.add(pair);
          void Bun.connect<Pair>({
            hostname: this.targetHost,
            port: this.targetPort,
            socket: {
              open: (upstream) => {
                upstream.data = pair;
                pair.upstream = upstream;
                for (const chunk of pair.pending) upstream.write(chunk);
                pair.pending = [];
              },
              data: (_upstream, chunk) => {
                if (!this.blackhole) pair.client.write(chunk);
              },
              close: () => {
                pair.client.end();
              },
              error: () => {
                pair.client.end();
              },
            },
          });
        },
        data: (client, chunk) => {
          if (this.blackhole) return;
          const { upstream } = client.data;
          if (upstream) upstream.write(chunk);
          else client.data.pending.push(new Uint8Array(chunk)); // cópia: o buffer recebido pode ser reutilizado
        },
        close: (client) => {
          client.data.upstream?.end();
          this.pairs.delete(client.data);
        },
        error: (client) => {
          client.data.upstream?.end();
        },
      },
    });
  }

  /** Para de responder: nenhum byte passa (como `docker compose pause postgres`). */
  pause(): void {
    this.blackhole = true;
  }

  /** Volta a responder. Conexões que perderam bytes são fechadas para o pool abrir novas. */
  resume(): void {
    if (!this.blackhole) return; // não derruba conexões saudáveis se não estava pausado
    this.closeAll();
    this.blackhole = false;
  }

  stop(): void {
    this.closeAll();
    this.listener?.stop(true);
  }

  private closeAll(): void {
    for (const pair of this.pairs) {
      pair.client.end();
      pair.upstream?.end();
    }
    this.pairs.clear();
  }
}
