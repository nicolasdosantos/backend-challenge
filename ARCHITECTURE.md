# ARCHITECTURE.md — Distributed Wagering Processor

Documento vivo: cada seção indica se a decisão já está **implementada** ou apenas **decidida** (implementação em etapa futura).

## 1. Stack e versões

| Item | Versão | Status |
|---|---|---|
| Bun (runtime, package manager, test runner) | 1.4.3 | implementado |
| NestJS | 12.1.2 | implementado |
| MikroORM (`core`, `postgresql`, `migrations`, `cli`) / `@mikro-orm/nestjs` | 7.2.5 / 7.1.0 | implementado |
| PostgreSQL | 17.11-alpine (digest fixado) | implementado |
| Emulador SQS: MiniStack | 1.5.24 (digest fixado) | implementado |
| TypeScript (somente type-check, `strict`) | 6.0.3 | implementado |

- Todas as dependências estão com versão exata em `package.json`; imagens com tag + digest em `docker-compose.yml` e `Dockerfile`.
- **TypeScript 6.0.3 em vez de 7.x:** o Bun transpila o código sozinho; o `tsc` serve apenas para type-check. A 7.x é a reescrita nativa recém-lançada; a 6.0.3 é a linha estável anterior, com menor risco de incompatibilidade com o ecossistema.

## 2. ORM: MikroORM e mapeamento

**Implementado:**
- Spike da Fase 1 (removido na Fase 2): mapeamento com `EntitySchema`, **sem decorators**, e `numeric(20,2)` lido/escrito como **string** exata pelo MikroORM 7 (`123456789012345678.99` voltou idêntico).
- Migrations executadas pelo CLI do MikroORM rodando no Bun (`bun --bun mikro-orm ...`), com `up` e `down`, transacionais (`transactional` + `allOrNothing`). A baseline (`Migration20261010160937_baseline`) foi criada com `migration:create --blank` e escrita à mão em SQL, porque constraints nomeadas, índice parcial e trigger não são gerados pelo diff do ORM.

**Implementado (Fase 3):** `src/database/records.ts` define um registro por tabela (`EntitySchema`, sem decorators, dinheiro como string) e `src/database/mappers.ts` converte registro ↔ domínio, sempre via `rehydrate` na leitura. `Money` = coluna `amount numeric(20,2)` + `currency char(3)` → `Money.from({ amount, currency })`. O `result_balance` da transação é reidratado na moeda **da wallet** (pode diferir da moeda da transação em `CURRENCY_MISMATCH`). Não há relações ORM entre registros (só colunas de FK); por isso a ordem das escritas é explícita: a transação é gravada (`flush`) antes do lançamento que a referencia.

## 2.1 Domínio (implementado na Fase 2)

Classes em `src/domain/`, sem dependência de ORM ou NestJS. Construtor privado + factories (`create`/`open`/`enqueue`/`receive` validam; `rehydrate` só reconstrói).

- **`Money`** (`decimal.js`, instância própria com `ROUND_HALF_EVEN`): imutável (`Object.freeze`), entrada só por string `^(0|[1-9]\d{0,17})(\.\d{1,2})?$` — rejeita vazio, `NaN`, `Infinity`, notação científica, negativos, mais de 2 casas, zero à esquerda e valores acima de `numeric(20,2)`. Aceita 0–2 casas (`"25"` → `"25.00"`); serializa sempre com 2. Como a entrada nunca tem mais de 2 casas e só há soma/subtração, **não ocorre arredondamento**. Moeda: 3 letras maiúsculas (formato ISO-4217; a lista de códigos não é validada). Valores negativos só existem internamente (`negate`, `subtract`).
- **`Wallet`**: `open` cria com o saldo inicial e `version = 1`; `openingEntry()` gera o lançamento CREDIT de 0 → saldo inicial **sem** incrementar a version (a abertura não é uma movimentação, é o estado inicial). `debit`/`credit` alteram saldo e version e **retornam o lançamento**: não existe caminho que mude o saldo sem gerar o lançamento. `debit` sem saldo lança `InsufficientFundsError`; o caso de uso decide o `failureCode` (`INSUFFICIENT_FUNDS` para BET, `REVERSAL_INSUFFICIENT_FUNDS` para reversão).
- **`WalletLedgerEntry`**: todos os campos `readonly`, sem métodos de transição, instância congelada; `create` valida valor positivo, saldo final não negativo e `balanceBefore ± money = balanceAfter`.
- **`WagerTransaction`**: transições documentadas no código — `PENDING → PROCESSED | PENDING_REFERENCE | REJECTED | FAILED`; `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`; terminais lançam `InvalidTransactionStateError`. `checkReference()` é a **única** validação de referência para WIN, LOSS, REFUND e ROLLBACK. Adaptações à assinatura do enunciado: `markProcessed`/`reject` recebem também o saldo resultante (`resultBalance`, necessário para o replay da regra 7.7) e `reject`/`fail` recebem o instante; `processedAt` registra a chegada a qualquer estado terminal.
- **`OutboxMessage`**: id = `eventId`; `scheduleRetry` com backoff 1s, 2s, 4s… teto de 5 min. **`InboxMessage`**: único por `(consumerName, messageId)`.
- **Eventos**: classe abstrata `IntegrationEvent<T>` + `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`, cada um com `eventType` e `version` no tipo. `data` só tem `MoneyProps` (strings). **`aggregateId` é sempre a `walletId`**, inclusive nos eventos de transação, para que a fila FIFO preserve a ordem dos eventos de uma mesma wallet.

## 2.2 Schema e garantias no banco (implementado na Fase 2)

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `wallets_balance_non_negative CHECK (balance >= 0)` |
| 1 wallet por player + moeda | `wallets_player_currency_unique` |
| Idempotência | `wager_transactions_idempotency_key_unique`; `wager_transactions_provider_external_unique` |
| Uma reversão por referência (regra 7.4 estrita) | índice único parcial `wager_transactions_single_reversal (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| Regras de referência por kind | `..._reversal_requires_reference`, `..._reference_allowed` |
| Coerência de status | `..._failure_code_matches_status`, `..._terminal_has_processed_at`, enums por `CHECK` |
| Ledger imutável | triggers `BEFORE UPDATE OR DELETE` (por linha) e `BEFORE TRUNCATE` (por comando) que lançam `restrict_violation` — testado inclusive `TRUNCATE wallets CASCADE` |
| Lançamento aritmeticamente correto | `wallet_ledger_entries_balanced`, `..._amount_positive`, `..._balances_non_negative` |
| 1 lançamento por transação e wallet | `wallet_ledger_entries_one_per_transaction` |
| Lançamento na moeda da wallet | FK composta `(wallet_id, currency) → wallets (id, currency)` |
| Dedup de inbox | PK `(consumer_name, message_id)` |

- `result_balance` em `wager_transactions` guarda o saldo observado ao finalizar a transação, devolvido em replays.
- `player_id`, `round_id`, `game_id` e ids externos são `text` (vêm do provedor, sem formato garantido); ids internos são `uuid` (v7).
- Limitação conhecida: `numeric(20,2)` **arredonda** silenciosamente valores com mais de 2 casas em vez de recusá-los; a escala é garantida pelo `Money`, que é o único caminho de escrita.
- O que **não** está no banco: "toda alteração de saldo tem lançamento" exigiria trigger diferido cruzando tabelas; essa garantia fica no agregado `Wallet` (saldo e lançamento nascem juntos, na mesma transação SQL) e é verificada pela reconciliação.

## 2.3 Taxonomia de `failureCode`

| Código | Quando | Orientação ao provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Não reenviar a mesma operação |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN/REFUND deixaria saldo negativo | Não reenviar; requer tratamento operacional |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | Corrigir payload (nova chave) |
| `PLAYER_MISMATCH` | playerId ≠ dono da wallet | Corrigir payload (nova chave) |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro da janela de `PENDING_REFERENCE` | Enviar a referência e depois a operação com nova chave |
| `REFERENCE_NOT_PROCESSED` | referência foi REJECTED/FAILED | Desistir: não há o que reverter |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada | Corrigir payload |
| `INVALID_REFERENCE_KIND` | tipo de referência não permitido (ex.: REFUND de WIN) | Corrigir payload |
| `AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | Corrigir payload |
| `ALREADY_REVERSED` | referência já tem reversão processada | Desistir: já revertida |
| `INTERNAL_ERROR` | erro permanente de infraestrutura (status `FAILED`) | Contatar operação |

Payload inválido, conflito de idempotência e wallet inexistente **não** são `failureCode`: são respostas HTTP (400/409/404) e nada é gravado.

## 3. Concorrência e estratégia transacional — implementado (Fase 3)

**Estratégia: lock pessimista na linha da wallet.** Cada operação (`ProcessWagerTransaction`) usa seu próprio `EntityManager` (`orm.em.fork()`) e roda em **uma** transação SQL (`transactional()`), que começa travando a wallet:

```sql
select ... from wallets where id = ? for update skip locked   -- livre? já está travada para nós
select ... from wallets where id = ? for update               -- só se a anterior não voltou nada: espera
```

- Por que lock pessimista e não otimista (`version`)? Uma wallet "quente" (muitas apostas ao mesmo tempo) com lock otimista gera muitos conflitos e retries; com `FOR UPDATE` as operações simplesmente fazem fila no PostgreSQL. É simples de explicar, não exige retry e funciona igual com N instâncias, porque o lock é do banco. O lock é **por linha** (por wallet): wallets diferentes não se bloqueiam — não há lock global.
- O `SKIP LOCKED` antes do `FOR UPDATE` serve só para medir conflitos: se a linha está travada por outra transação, ele devolve vazio sem erro e sem abortar a transação; aí contamos `wallet_lock_conflicts_total` e esperamos com o `FOR UPDATE` normal. (Um `NOWAIT` daria erro e abortaria a transação, exigindo savepoint.)
- Depois do lock, a sequência é ler → calcular no agregado → gravar, mas **com a linha travada**, então não há lost update. `version` é incrementada pelo agregado só quando o saldo muda (útil para auditoria e para o evento `WalletBalanceChanged`), mas não é o mecanismo de controle de concorrência.
- O banco continua sendo a última barreira: `CHECK (balance >= 0)`, uniques e trigger do ledger.
- Pool de conexões configurável (`DB_POOL_MAX`, padrão 10; testes usam 60): uma operação esperando o lock segura uma conexão, então o pool precisa ser maior que o paralelismo esperado por instância.
- SQL emitido (verificado com log de queries): `begin` → `... for update skip locked` → `... for update` → `commit`.

**Rejeição de negócio faz commit.** BET sem saldo, `playerId` ou moeda divergentes não são exceção: a transação termina `REJECTED` com `failureCode`, é gravada junto com o evento `WagerTransactionRejected` na outbox e a transação SQL é **confirmada** (auditável). Não há lançamento nem mudança de saldo/version. Exceções (que fazem rollback) ficam para payload inválido (400), wallet inexistente (404), funcionalidade ainda não suportada e falhas de infraestrutura.

**Atomicidade.** Transação, lançamento, saldo/version e eventos da outbox são escritos na mesma transação SQL; nada é publicado no SQS aqui. O método `protected beforeCommit()` (no-op) existe só para o teste sobrescrever e simular uma falha depois de todas as escritas: o teste prova que o saldo já estava atualizado dentro da transação e que, após a falha, saldo, transação, ledger e outbox voltam ao estado anterior.

**Eventos por operação:** BET/WIN → `WagerTransactionProcessed` + `WalletBalanceChanged`; LOSS → só `WagerTransactionProcessed`; rejeição → `WagerTransactionRejected`; abertura com saldo > 0 → `WagerTransactionProcessed` (OPENING) + `WalletBalanceChanged`.

**Limites desta fase:** WIN/LOSS com referência, REFUND e ROLLBACK lançam `NotSupportedYetError` (HTTP 501 `NOT_SUPPORTED_YET`) até a Fase 5 — nunca são ignorados em silêncio.

## 4. Idempotência — implementado (Fases 3 e 4)

Tudo no PostgreSQL; nenhum cache em memória participa (provado com 3 processos independentes).

**Algoritmo do `payloadHash`** (`src/wagering/payload-hash.ts`, a mesma função para HTTP e SQS):
1. Monta o objeto só com os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` (quando houver). `money` é normalizado pelo `Money` (`"25"` e `"25.00"` geram o mesmo hash).
2. Serializa como JSON canônico: chaves ordenadas recursivamente (ordem de code unit), sem espaços, campos `undefined` omitidos.
3. `SHA-256` do texto UTF-8, em hexadecimal (64 caracteres).
- Ficam **fora**: o header `Idempotency-Key`, `messageId`, `occurredAt`, `correlationId`, `causationId` e qualquer campo extra. A transação interna OPENING usa a própria chave interna como hash (não vem de provedor).

**Chave:** na API, o header `Idempotency-Key` é obrigatório (ausente → 400) e é a fonte da verdade; se o corpo trouxer `idempotencyKey` diferente → 400.

**Fluxo dentro da transação SQL** (`ProcessWagerTransaction`):
1. `SELECT ... FOR UPDATE` na wallet (serializa operações da mesma wallet, em qualquer instância).
2. Busca por `idempotency_key`. Existe → hash igual = **replay**; hash diferente = **409 `IDEMPOTENCY_KEY_CONFLICT`**.
3. Decide a operação **em memória** (agregado `Wallet`), sem escrever nada.
4. `INSERT INTO wager_transactions ... ON CONFLICT DO NOTHING RETURNING id` — **antes** de qualquer escrita de saldo, ledger ou outbox.
5. Se o INSERT não inseriu (corrida que o lock não cobre: mesma chave em **wallets diferentes**, ou mesmo `(providerId, externalTransactionId)` com outra chave): o PostgreSQL esperou o commit da outra transação, então a linha já é visível. Relê por chave → replay ou 409; senão relê por `(provider_id, external_transaction_id)` → **409 `DUPLICATE_EXTERNAL_TRANSACTION`**. Como nada além do INSERT foi tentado, nenhum saldo/ledger muda (provado em teste determinístico, com a segunda transação comprovadamente esperando no INSERT via `pg_stat_activity`).
6. Só se inseriu: lançamento, saldo/version e eventos na outbox, mesmo commit.
- O `ON CONFLICT DO NOTHING` evita que a violação de unique aborte a transação SQL (não precisa de savepoint nem de retry).

**Replay devolve o resultado original:** PROCESSED com o saldo **da época** (`result_balance`), REJECTED com o mesmo `failureCode` (HTTP 422), PENDING_REFERENCE com o estado atual (saldo atual da wallet, HTTP 202). Sempre `idempotentReplay: true`.

**Métrica:** `idempotency_duplicates_total{type}` com `type` = `replay`, `idempotency_key_conflict`, `duplicate_external_transaction`.

- Inbox (dedup de transporte por `(consumer_name, message_id)`, Fase 6) e idempotência (dedup de negócio) são camadas diferentes; as duas ficam no PostgreSQL.

## 5. Mensageria (SQS)

**Implementado:**
- Filas FIFO: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wallet-events.fifo`. Criadas por `scripts/create-queues.ts` (idempotente), executado pelo serviço `sqs-init` do Compose.
- Redrive policy: `wager-transactions.fifo` → DLQ após `maxReceiveCount = 5`.
- **`wallet-events.fifo` é uma interpretação.** O enunciado (§10) lista apenas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, mas exige que a outbox publique eventos de integração (§11) sem dizer onde. Publicar os eventos na própria `wager-transactions.fifo` misturaria comandos de entrada com eventos de saída: o consumidor teria de ignorar mensagens que não são `WagerTransactionRequested`, e um evento malformado poderia ir parar na DLQ de transações. Por isso, uma fila separada só para saída. `MessageGroupId` = `aggregateId` (walletId) preserva a ordem por wallet; `MessageDeduplicationId` = `eventId` reduz duplicatas na janela de 5 min do SQS — os consumidores ainda devem deduplicar pelo `eventId`.

**Escolha do emulador — MiniStack em vez de LocalStack:**
- Desde a versão 2026.03.0, a imagem do LocalStack exige auth token de conta para iniciar; o avaliador também precisaria de conta. O enunciado aceita MiniStack, que é MIT e não exige conta.
- Antes de adotar, `scripts/check-sqs-emulator.ts` comprovou: ordem FIFO por `MessageGroupId` (e bloqueio do grupo com mensagem em voo), dedup por `MessageDeduplicationId`, `ChangeMessageVisibility`, reentrega após visibility timeout (com `ApproximateReceiveCount`) e redrive para DLQ via `maxReceiveCount`. Resultado: 6/6 PASS.
- Plano B, não utilizado: LocalStack fixado em tag anterior a 2026.03.

**Decidido (Fase 6):** consumidor com ack somente após commit; erros de negócio → ack; transitórios → retry com backoff via `ChangeMessageVisibility`; permanentes → DLQ. Wallet inexistente via SQS é **erro permanente** (não há onde gravar a transação) → DLQ.

## 6. Regras de negócio — interpretações adotadas

| Tema | Decisão | Justificativa / trade-off |
|---|---|---|
| Reversões (regra 7.4) | **Leitura estrita:** uma referência aceita no máximo **uma** reversão (REFUND **ou** ROLLBACK), garantida por índice único parcial no banco. ROLLBACK de um REFUND continua permitido (a referência é outra transação). | Invariante global "não duplicar créditos": com a leitura literal ("pelo mesmo tipo"), uma BET poderia receber REFUND **e** ROLLBACK e creditar duas vezes. Trade-off: um provedor que envie as duas recebe rejeição na segunda. |
| BET com `referenceExternalTransactionId` | 400 (payload inválido) | O enunciado não prevê referência em BET. |
| WIN / LOSS com referência | Opcional; se presente, validada pela **mesma função** (mesmo provider, player, wallet, moeda e rodada, e deve ser uma BET). Referência ausente → `PENDING_REFERENCE`. | §7 "WIN pode referenciar a BET"; LOSS é o outro resultado da mesma BET. Sem igualdade de valor (regra 5 vale só para reversões). |
| `playerId` ou moeda do payload ≠ da wallet | `REJECTED` com `failureCode` próprio (`PLAYER_MISMATCH`, `CURRENCY_MISMATCH`) | Rejeição de negócio auditável. |
| Wallet inexistente | HTTP 404, nada é gravado; via SQS → DLQ | Não existe wallet onde registrar a transação. |
| Referência existe mas não está `PROCESSED` | `REJECTED`/`FAILED` → rejeita com `REFERENCE_NOT_PROCESSED`; ainda pendente → continua `PENDING_REFERENCE` | — |
| Reversão que deixaria saldo negativo | `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS` (≠ `INSUFFICIENT_FUNDS`) | Regra 7.9. |
| `PENDING_REFERENCE` | Worker com backoff exponencial, até 6 tentativas (2s, 4s, …, 64s ≈ 2 min). Esgotado → `REJECTED` `REFERENCE_NOT_FOUND` + evento. Configurável por variável de ambiente (testes usam valores curtos). | **Trade-off:** janela curta libera o estado rápido, mas uma referência que chegue depois de ~2 min não será casada. Em produção a janela seria calibrada pelo SLA de reenvio dos provedores. |
| `PENDING` / `FAILED` | `PENDING` é o estado inicial em memória (criação e aplicação ocorrem na mesma transação SQL). `FAILED` é gravado em transação separada para erro permanente de infraestrutura. | — |

## 7. API — implementado (Fase 4)

**Endpoints:** `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?cursor&limit`, `POST /wallets/:walletId/reconciliation`, `POST /wagering/transactions`, `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `GET /health/live`, `GET /health/ready`, `GET /metrics`.

**Mapeamento HTTP — igual em todos os endpoints** (erros centralizados em `src/http-exception.filter.ts`):

| Situação | HTTP | `code` | `retryable` | O provedor deve… |
|---|---|---|---|---|
| Wallet criada | 201 | — | — | — (o único 201: criação de recurso) |
| Transação PROCESSED (original **ou** replay) | 200 | — | — | `idempotentReplay` diz se é replay |
| Transação aceita em PENDING_REFERENCE (original ou replay) | 202 | — | — | aguardar / consultar depois |
| Rejeição de regra de negócio (REJECTED) | 422 | `BUSINESS_RULE_REJECTED` + `failureCode` | false | não reenviar igual (ver taxonomia §2.3) |
| Payload inválido, header ausente, cursor/limit inválido, JSON malformado, OPENING pela API | 400 | `INVALID_PAYLOAD` | false | corrigir o payload |
| Wallet / transação / rota inexistente | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` | false | corrigir o id |
| Mesma chave com outro payload | 409 | `IDEMPOTENCY_KEY_CONFLICT` | false | usar outra chave |
| Mesmo `(providerId, externalTransactionId)` com outra chave | 409 | `DUPLICATE_EXTERNAL_TRANSACTION` | false | reenviar com a chave original |
| Wallet duplicada (player + moeda) | 409 | `WALLET_ALREADY_EXISTS` | false | usar a wallet existente |
| Ainda não implementado (WIN/LOSS com referência, REFUND, ROLLBACK — até a Fase 5) | 501 | `NOT_SUPPORTED_YET` | false | — |
| Falha transitória de infraestrutura (banco fora, timeout, deadlock) | 503 + `Retry-After: 2` | `SERVICE_UNAVAILABLE` | true | reenviar a mesma requisição (idempotência garante 1 efeito) |
| Erro inesperado | 500 | `INTERNAL_ERROR` | false | contatar a operação |

**Corpo de erro único:** `{ code, message, retryable, failureCode? }`. No 422 o corpo traz, além disso, o resultado gravado (`transactionId`, `status`, `balance`, `idempotentReplay`), para que o replay seja idêntico ao original. Health checks mantêm o corpo próprio `{ status, checks }`.

**Por que 200 (e não 201) para transações:** o mesmo pedido pode ser original ou replay e o enunciado pede a mesma resposta nos dois casos; o campo `idempotentReplay` diferencia. 201 fica só para a criação de wallet.

**503 em vez de 500/travamento:** o pool do `pg` recebe `connectionTimeoutMillis` (`DB_CONNECT_TIMEOUT_MS`, padrão 5 s; também limita a espera por conexão livre) e `query_timeout` (`DB_QUERY_TIMEOUT_MS`, padrão 10 s). Assim, com o banco sem responder (ex.: `docker compose pause postgres`), a requisição falha em vez de travar. `src/infrastructure-errors.ts` classifica como transitório: `ConnectionException`/`DeadlockException`/`LockWaitTimeoutException` do MikroORM, códigos de rede (`ECONNREFUSED`, `ECONNRESET`, …), SQLSTATE de conexão/serialização (`08xxx`, `53300`, `57P01`, `40001`, `40P01`) e as mensagens de timeout do `pg`. A mesma função será usada pelo consumidor SQS (retry × DLQ).

**Ledger com cursor:** keyset em `(created_at, id)` ascendente; cursor opaco = JSON `{ createdAt, id }` em base64url; `limit` padrão 50, máximo 100; cursor/limit inválido → 400. Entradas novas entram no fim da ordem, então páginas seguintes não repetem nem pulam itens (testado com inserções entre páginas). **Limitação:** `created_at` vem do relógio da instância; entre instâncias com relógios desalinhados, uma entrada nova poderia ganhar `created_at` anterior a um cursor já entregue. Mitigação possível: preencher `created_at` com `clock_timestamp()` do banco.

## 8. Autenticação — decidido: não implementar

Autenticação não pontua (enunciado §2). Ponto de extensão: `src/auth/provider-auth.guard.ts` (guard no-op). Desenho previsto: provedores autenticam via OAuth2 client credentials num IdP externo (Keycloak no Compose); o guard valida o JWT (assinatura via JWKS, `aud`, expiração) e exige que o `providerId` do token seja igual ao do payload. Health checks ficam sempre abertos; mensagens da fila são canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.

## 9. Observabilidade

**Implementado:** logs JSON pelo `ConsoleLogger` nativo do NestJS (`json: true`), sem dependência extra. `/health/live` (processo vivo) e `/health/ready` (`select 1` no PostgreSQL + `GetQueueUrl` no SQS, timeout de 2s cada; 503 se algum falhar). Cada check que falha gera log `warn` com o nome do check e `nome: mensagem` do erro (sem connection string ou credenciais), ex.: `{"level":"warn","message":{"message":"readiness check failed","check":"postgres","reason":"Error: timeout after 2000ms"}}`.
- O readiness usa `select 1` porque o `checkConnection()` do MikroORM 7 responde "Connection not established" sem ir ao banco enquanto o pool não abriu conexão.

**Logs das operações (Fase 3):** `{ message, correlationId, transactionId, walletId, providerId, kind, status, failureCode, idempotentReplay }` — sem valores monetários nem payload completo. `correlationId` vem do header `x-correlation-id` (ou é gerado). `messageId` entra na Fase 6.

**Métricas (`GET /metrics`, formato Prometheus) — `prom-client` 15.1.3.** Escolhido por ser o padrão de fato, pure JS (verificado rodando no Bun antes de adotar) e por já trazer histogramas com buckets, que seriam trabalhosos de escrever à mão. Usa um `Registry` próprio (não o global), para que vários apps no mesmo processo de teste não colidam.

| Métrica | Tipo | Desde |
|---|---|---|
| `wager_transactions_total{kind,status}` | counter (só transações novas, não replays) | Fase 3 |
| `wager_transaction_processing_seconds{kind}` | histogram (inclui espera pelo lock) | Fase 3 |
| `wallet_lock_conflicts_total` | counter (wallet já travada por outra transação) | Fase 3 |
| `reconciliation_mismatches_total` | counter | Fase 3 |
| `idempotency_duplicates_total{type}` | counter (replay, conflito de chave, external duplicado) | Fase 4 |
| retries, DLQ, outbox lag | — | Fase 6 |

**Reconciliação (`POST /wallets/:walletId/reconciliation`).** Uma única consulta SQL lê o saldo armazenado e soma créditos e débitos do ledger (mesmo snapshot, sem falso alarme por commit no meio). Devolve `storedBalance`, `calculatedBalance`, `difference` (= armazenado − calculado), `consistent`, `checkedEntries`. Divergência gera log `error`, incrementa `reconciliation_mismatches_total` e é sinalizada na resposta; **nunca é corrigida**.

## 10. Ambiente de testes

- Testes de integração usam PostgreSQL e MiniStack reais (containers), banco separado `wagering_test` (o helper recusa qualquer banco que não termine em `_test`) e filas com prefixo único por execução.
- **Dados nos testes:** cada teste cria seus próprios registros com ids novos (UUID v7) e nunca depende de tabela vazia — **não há limpeza entre testes e nenhum trigger ou constraint é desligado** (nem `session_replication_role`). Reset completo, quando necessário, é feito pela própria migration (`down` até 0 e `up`), como no teste de migrations.
- Unitários rodam local (Windows) ou no container; integração e processos rodam no container Linux (`docker compose run --rm tests`, com o código montado como volume).
- **Windows não entrega SIGTERM**: medido com `Bun.spawn` + `kill('SIGTERM')` — o handler não executa e o processo morre com código 143. Não existe distro Linux no WSL (só `docker-desktop`), então testes de processo/sinais rodam no container Linux: `docker compose run --rm tests`, onde passam.
- **Indisponibilidade do banco nos testes:** dentro do container de testes não há `docker`, então `test/support/tcp-proxy.ts` (proxy TCP de teste entre app e PostgreSQL) simula o `docker compose pause`: em pausa, descarta todos os bytes. O `docker compose pause postgres` real foi verificado manualmente a partir do host (503 + `Retry-After`, processo continua vivo, reenvio processa uma única vez).
- **Múltiplas instâncias:** `test/concurrency/multi-instance.test.ts` sobe 3 processos `bun run src/main.ts` (portas 3101–3103) com `Bun.spawn`, todos no mesmo PostgreSQL.

## 11. Problemas conhecidos

- **Vazamento de conexão quando o `BEGIN` falha (bug do kysely 0.29.6, usado pelo MikroORM 7.2.5; 0.29.6 também é a versão mais recente).** Em `ControlledTransactionBuilder.execute()`, a conexão é obtida do pool e, se `beginTransaction` lança (ex.: `Query read timeout` com o banco sem responder), ela nunca é liberada. Medido: depois de 1 POST durante a pausa, o pool fica com 1 conexão emprestada para sempre (também após o banco voltar); consultas simples (sem transação) não vazam. Impacto: cada `BEGIN` que falha consome 1 das `DB_POOL_MAX` conexões; após N falhas a instância só responde 503 até reiniciar, e o `close()` (shutdown) espera para sempre por elas. **Correção proposta, aguardando autorização:** `bun patch kysely` liberando (e descartando) a conexão no `catch` do `beginTransaction` — cerca de 4 linhas, com teste. Até lá, o teste de indisponibilidade fecha o app com prazo limitado e há um `test.todo` registrando o comportamento esperado.
