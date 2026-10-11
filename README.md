# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de vários provedores de jogos, pela API HTTP e por uma fila SQS. O foco é correção financeira: saldo nunca negativo, ledger imutável e reconciliável, idempotência persistente, correção com várias instâncias e recuperação após falhas (mensagens duplicadas, fora de ordem, processo morto antes ou depois do commit).

As decisões técnicas, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Item | Versão |
|---|---|
| Bun (runtime, gerenciador de pacotes, testes) | 1.4.3 |
| TypeScript (strict) | 6.0.3 |
| NestJS | 12.1.2 |
| PostgreSQL | 17.11 (Docker) |
| MikroORM | 7.2.5 (migrations versionadas e reversíveis) |
| SQS | MiniStack 1.5.24, emulador compatível com a API do SQS (Docker) |
| Dinheiro | `decimal.js` (nunca `number`) |
| Métricas | `prom-client` (formato Prometheus) |

## Pré-requisitos

- [Bun](https://bun.sh) 1.4.x
- Docker com Docker Compose (Docker Desktop no Windows/macOS)
- Portas livres: `3000` (API), `5432` (PostgreSQL), `4566` (SQS)

## Setup do zero

```bash
git clone https://github.com/nicolasdosantos/backend-challenge.git
cd backend-challenge
cp .env.example .env                           # valores de desenvolvimento local, sem segredos
bun install                                    # aplica também o patch em patches/ (ver ARCHITECTURE.md §11)
docker compose up -d postgres sqs sqs-init     # PostgreSQL, emulador SQS e criação das filas
bun run migration:up                           # cria o schema
bun run start                                  # API em http://localhost:3000
```

O `sqs-init` cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (com redrive policy) e `wallet-events.fifo` e termina. O PostgreSQL também cria o banco `wagering_test`, usado pelos testes.

Com `bun run start` sobem juntos: a API, o consumidor da fila `wager-transactions.fifo`, o publicador da outbox e o worker de `PENDING_REFERENCE`. Cada um pode ser desligado por variável de ambiente (tabela abaixo), por exemplo para rodar uma instância só de API.

Para parar: `Ctrl+C` na app (encerramento gracioso) e `docker compose down` (mantém os dados; `docker compose down -v` apaga os volumes).

## Testes

| O quê | Comando | Onde roda |
|---|---|---|
| Checagem de tipos | `bun run typecheck` | local |
| Unitários | `bun test test/unit` | local (qualquer SO) |
| Suíte completa (unitários, integração, concorrência, processos) | `docker compose build tests && docker compose run --rm tests` | container Linux, com PostgreSQL e SQS reais |
| Só concorrência e processos | `docker compose run --rm tests bun test test/concurrency` | container Linux |
| Capacidades do emulador SQS | `bun run scripts/check-sqs-emulator.ts` | local, com o compose no ar |

- Os testes de integração e concorrência usam PostgreSQL e SQS **reais** (containers do compose); nada é mockado. Eles usam o banco `wagering_test` (o helper recusa qualquer banco que não termine em `_test`) e filas com prefixo único por execução.
- Rode a suíte completa **no container**: os testes de processos dependem de sinais POSIX (`SIGTERM`), que o Windows não entrega a processos filhos. No Windows, use localmente só os unitários.
- O container de testes monta o código do diretório atual; depois de mudar dependências (`package.json`), rode `docker compose build tests` de novo.

## API

Corpo de erro único em todos os endpoints: `{ "code", "message", "retryable", "failureCode"? }`. A tabela completa de códigos HTTP está em [ARCHITECTURE.md §7](ARCHITECTURE.md#7-api-e-mapeamento-http).

### Criar wallet

```bash
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# 201 {"id":"<walletId>","playerId":"player-1","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
```

Wallet duplicada (mesmo `playerId` e moeda) → `409 WALLET_ALREADY_EXISTS`.

### Submeter transação

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "player-1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# 200 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

- Repetir a mesma requisição devolve o resultado original com `"idempotentReplay": true`.
- Mesma `Idempotency-Key` com outro payload → `409 IDEMPOTENCY_KEY_CONFLICT`.
- Rejeição de negócio (ex.: saldo insuficiente) → `422` com `failureCode`.
- `REFUND`/`ROLLBACK` levam `"referenceExternalTransactionId"`; se a referência ainda não chegou → `202 PENDING_REFERENCE`.

### Consultas

```bash
curl -s http://localhost:3000/wallets/<walletId>
curl -s "http://localhost:3000/wallets/<walletId>/ledger?limit=50"          # cursor opaco em nextCursor
curl -s "http://localhost:3000/wallets/<walletId>/ledger?limit=50&cursor=<nextCursor>"
curl -s http://localhost:3000/wagering/transactions/<transactionId>
curl -s http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

### Reconciliação, health e métricas

```bash
curl -s -X POST http://localhost:3000/wallets/<walletId>/reconciliation
# {"walletId":"…","storedBalance":…,"calculatedBalance":…,"difference":…,"consistent":true,"checkedEntries":2}

curl -s http://localhost:3000/health/live      # processo vivo
curl -s http://localhost:3000/health/ready     # 200 com PostgreSQL e SQS alcançáveis; 503 se algum cair
curl -s http://localhost:3000/metrics          # formato Prometheus
```

## Mensageria

- **Entrada:** mensagens `WagerTransactionRequested` na fila `wager-transactions.fifo` são processadas pelo mesmo caso de uso da API, com inbox persistente (deduplicação por `messageId`) na mesma transação SQL e ack só depois do commit. Erros permanentes vão para `wager-transactions-dlq.fifo`.
- **Saída:** eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados na outbox na mesma transação e publicados em `wallet-events.fifo` pelo publicador.

Enviar uma mensagem de teste (com a app rodando e o `.env` carregado):

```bash
bun run scripts/send-wager-message.ts <walletId> player-1 25.00 BET
# {"sent":true,"messageId":"msg-…","externalTransactionId":"tx-…"}
curl -s http://localhost:3000/providers/provider-a/wagering/transactions/<externalTransactionId>
```

## Variáveis de ambiente

Todas estão em `.env.example` com os valores padrão de desenvolvimento.

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | porta da API |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | conexão com o PostgreSQL |
| `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | `10`, `5000`, `10000` | pool e timeouts (banco sem resposta vira 503 em vez de travar) |
| `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | emulador local | conexão SQS (credenciais fictícias do emulador) |
| `SQS_QUEUE_PREFIX` | vazio | prefixo dos nomes das filas |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor da fila de entrada |
| `SQS_CONSUMER_*` | ver `.env.example` | lote, long polling, visibility, backoff, `MAX_RECEIVE_COUNT` (igual ao da redrive policy), timeout de shutdown |
| `OUTBOX_PUBLISHER_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE` | `true`, `500`, `20` | publicador da outbox |
| `PENDING_REFERENCE_*` | `true`, `1000`, `2000`, `6` | worker de `PENDING_REFERENCE` (liga, intervalo, atraso base, tentativas) |
| `FAULT_CRASH_AFTER_COMMIT` | vazio | **recurso de teste**: `1` encerra o processo após o commit e antes do ack. Nunca usar em produção |

## Estrutura

```
src/domain/        regras de negócio puras (Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos)
src/database/      registros MikroORM (EntitySchema), mappers e migration
src/wagering/      caso de uso de transações, worker de PENDING_REFERENCE, API de transações
src/wallets/       abertura de wallet, consultas, ledger, reconciliação
src/messaging/     consumidor SQS e publicador da outbox
src/health, src/metrics, src/auth   health checks, métricas Prometheus, ponto de extensão de autenticação
test/unit, test/integration, test/concurrency, test/process   testes por tipo
scripts/           criação das filas, envio de mensagem de teste, verificação do emulador
patches/           patch local do kysely (ver ARCHITECTURE.md §11)
```

## Limitações conhecidas

Resumo; detalhes e justificativas em [ARCHITECTURE.md §12](ARCHITECTURE.md#12-limitações-e-trade-offs-conhecidos).

- Autenticação não implementada (não pontua no desafio); há um ponto de extensão (`ProviderAuthGuard`) e o desenho previsto está documentado.
- Patch local no kysely 0.29.6 para não vazar conexões quando um `BEGIN` falha; deve ser removido quando o upstream corrigir.
- Janela de `PENDING_REFERENCE` de ~2 minutos (configurável): uma referência que chegue depois disso não é casada.
- Ordem dos eventos publicados é best-effort; o consumidor de eventos deve deduplicar pelo `eventId`.
- Testado com o emulador MiniStack; não foi testado contra AWS SQS real.
