# Arquitetura — Distributed Wagering Processor

Decisões técnicas, garantias, interpretações do enunciado e limitações conhecidas. Setup e comandos estão no [README](README.md).

## 1. Visão geral

```
HTTP  POST /wagering/transactions ─┐
                                   ├─► ProcessWagerTransaction (uma transação SQL por operação)
SQS   wager-transactions.fifo ─────┘     inbox* → lock da wallet → idempotência → regras (domínio)
        │  (consumidor: ack só após o commit;  → transação + ledger + saldo + outbox → COMMIT
        │   erro permanente → DLQ)                       │
        ▼                                                 ▼
  wager-transactions-dlq.fifo                    outbox_messages ──► publicador (SKIP LOCKED) ──► wallet-events.fifo
                                                 PENDING_REFERENCE ──► worker com backoff (reavalia com a mesma lógica)
* inbox só na entrada via SQS
```

O PostgreSQL é a fonte da verdade e a última barreira das invariantes (constraints, índice único parcial, trigger do ledger). SQS FIFO, deduplicação do broker e ordem de entrega são otimizações; a correção não depende delas.

## 2. Stack e versões

| Item | Versão |
|---|---|
| Bun (runtime, gerenciador de pacotes, testes) | 1.4.3 |
| NestJS | 12.1.2 |
| MikroORM (`core`, `postgresql`, `migrations`, `cli`) / `@mikro-orm/nestjs` | 7.2.5 / 7.1.0 |
| PostgreSQL | 17.11-alpine (tag + digest) |
| Emulador SQS: MiniStack | 1.5.24 (tag + digest) |
| `decimal.js` / `prom-client` | 10.6.0 / 15.1.3 |
| TypeScript (só checagem de tipos, `strict`) | 6.0.3 |

- Versões exatas no `package.json`; imagens com tag + digest no `docker-compose.yml` e no `Dockerfile`.
- **TypeScript 6.0.3, não 7.x:** o Bun transpila o código; o `tsc` só faz checagem de tipos. A 7.x é a reescrita nativa, recém-lançada; a 6.0.3 tem menos risco de incompatibilidade.
- **MiniStack, não LocalStack:** desde a versão 2026.03.0 a imagem do LocalStack exige token de conta para iniciar (o avaliador também precisaria de conta). O enunciado aceita MiniStack (MIT, sem conta). Antes de adotar, `scripts/check-sqs-emulator.ts` comprovou ordem FIFO por grupo, deduplicação, `ChangeMessageVisibility`, reentrega após visibility timeout e redrive para a DLQ; nenhuma divergência do SQS apareceu nos testes.

## 3. Domínio (`src/domain/`)

Classes sem dependência de ORM ou NestJS. Construtor privado + factories (`create`/`open`/`enqueue`/`receive` validam; `rehydrate` só reconstrói o estado persistido, sem revalidar transições).

- **`Money`** (`decimal.js`, instância própria com `ROUND_HALF_EVEN`): imutável. Entrada só por string `^(0|[1-9]\d{0,17})(\.\d{1,2})?$` — rejeita vazio, `NaN`, `Infinity`, notação científica, negativos, mais de 2 casas, zero à esquerda e valores acima de `numeric(20,2)`. Serializa sempre com 2 casas (`"25"` → `"25.00"`). Como a entrada nunca tem mais de 2 casas e só há soma e subtração, **não ocorre arredondamento**. Moeda: 3 letras maiúsculas (formato ISO-4217; a lista de códigos não é validada). Operações entre moedas diferentes lançam erro.
- **`Wallet`** (agregado): `open` cria com o saldo inicial e `version = 1`; `openingEntry()` gera o lançamento CREDIT de 0 até o saldo inicial **sem** mudar a version (a abertura é o estado inicial, não uma movimentação). `debit`/`credit` alteram saldo e version e **devolvem o lançamento**: não existe caminho que mude o saldo sem gerar o lançamento.
- **`WalletLedgerEntry`**: campos `readonly`, sem métodos de transição, instância congelada; `create` valida valor positivo, saldo final não negativo e `balanceBefore ± money = balanceAfter`.
- **`InboxMessage`** (único por `consumerName + messageId`) e **`OutboxMessage`** (id = `eventId`; `scheduleRetry` com backoff 1s, 2s, 4s… até 5 min).
- **Eventos:** classe abstrata `IntegrationEvent<T>` e uma subclasse por evento (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`), com `eventType` e `version` no tipo. `data` só carrega `MoneyProps` (strings). `aggregateId` = `walletId` em todos.

### 3.1 Transições de `WagerTransaction`

| De | Para | Quando |
|---|---|---|
| `PENDING` (só em memória) | `PROCESSED` | regra aplicada (com lançamento quando o kind mexe no saldo) |
| `PENDING` | `REJECTED` | violação de regra de negócio (com `failureCode`) |
| `PENDING` | `PENDING_REFERENCE` | a referência ainda não existe ou ainda não terminou |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | reavaliação do worker sem a referência (nova tentativa agendada) |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` | referência resolvida; ou tentativas esgotadas (`REFERENCE_NOT_FOUND`) |
| `PENDING` | `FAILED` | erro inesperado e não recuperável no consumidor SQS, na última tentativa (`INTERNAL_ERROR`, §9.3) |
| `PROCESSED`, `REJECTED`, `FAILED` | — | **terminais**: qualquer transição lança `InvalidTransactionStateError` (erro de programação) |

`PENDING` nunca é gravado: a transação é criada e avaliada dentro da mesma transação SQL. `processedAt` registra a chegada a qualquer estado terminal; `resultBalance` guarda o saldo observado nesse momento (devolvido nos replays).

## 4. Persistência e schema

**ORM: MikroORM** (preferencial no enunciado). Unit of Work e `EntityManager.transactional()` explícitos, `LockMode` para o `FOR UPDATE`, migrations versionadas pelo CLI (que roda no Bun). As tabelas são mapeadas por `EntitySchema` em `src/database/records.ts` — **sem decorators** — e `src/database/mappers.ts` converte registro ↔ domínio (`rehydrate` na leitura). Assim o domínio não depende de tipos do ORM.

**Mapeamento do `Money`:** coluna `amount numeric(20,2)` + coluna `currency char(3)`. O MikroORM lê e escreve `numeric` como **string** exata (`"123456789012345678.99"` volta idêntico, testado); a reidratação é `Money.from({ amount, currency })`.

**Migration** (`src/database/migrations/Migration20261010160937_baseline.ts`): SQL explícito, porque constraints nomeadas, índice parcial e trigger não saem do diff do ORM. Transacional, com `up` e `down` (testado: `up`, `down` até 0, `up`).

| Garantia | Mecanismo no banco |
|---|---|
| Saldo nunca negativo | `wallets_balance_non_negative CHECK (balance >= 0)` |
| 1 wallet por player + moeda | `wallets_player_currency_unique` |
| Idempotência | `wager_transactions_idempotency_key_unique`; `wager_transactions_provider_external_unique` |
| Uma reversão processada por referência | índice único parcial `wager_transactions_single_reversal (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| Regras de referência por kind | `..._reversal_requires_reference`, `..._reference_allowed` |
| Coerência de status | `..._failure_code_matches_status`, `..._terminal_has_processed_at`, `..._pending_reference_scheduled`, enums por `CHECK` |
| Ledger imutável | triggers `BEFORE UPDATE OR DELETE` (por linha) e `BEFORE TRUNCATE` (por comando) que lançam `restrict_violation` (inclusive `TRUNCATE wallets CASCADE`) |
| Lançamento aritmeticamente correto | `wallet_ledger_entries_balanced`, `..._amount_positive`, `..._balances_non_negative` |
| 1 lançamento por transação e wallet | `wallet_ledger_entries_one_per_transaction` |
| Lançamento na moeda da wallet | FK composta `(wallet_id, currency) → wallets (id, currency)` |
| Dedup da inbox | PK `(consumer_name, message_id)` |
| Ordem estável do ledger | `seq bigint generated always as identity` (único), índice `(wallet_id, seq)` |

- Ids internos são UUID v7; ids que vêm do provedor (`player_id`, `round_id`, ids externos) são `text`.
- Não está no banco: "toda alteração de saldo tem lançamento" exigiria um trigger diferido entre tabelas. A garantia fica no agregado (saldo e lançamento nascem juntos, na mesma transação SQL) e é verificada pela reconciliação.

## 5. Concorrência e estratégia transacional

**Uma operação = uma transação SQL**, com seu próprio `EntityManager` (`orm.em.fork()`), começando pelo **lock pessimista na linha da wallet**:

```sql
select ... from wallets where id = ? for update skip locked   -- livre? já está travada para nós
select ... from wallets where id = ? for update               -- só se a anterior não devolveu nada: espera
```

- **Por que pessimista e não otimista:** uma wallet "quente" com lock otimista (`version`) gera conflitos e retries; com `FOR UPDATE` as operações fazem fila no PostgreSQL. Não precisa de retry e funciona igual com N instâncias, porque o lock é do banco. É **por linha** (por wallet): wallets diferentes não se bloqueiam — não há lock global.
- **Por que `SKIP LOCKED` antes do `FOR UPDATE`:** só para contar conflitos (`wallet_lock_conflicts_total`). Se outra transação já segura a linha, o `SKIP LOCKED` devolve vazio sem erro e sem abortar a transação; aí espera-se com o `FOR UPDATE` normal. (Um `NOWAIT` daria erro e abortaria a transação, exigindo savepoint.)
- Depois do lock, ler → calcular no agregado → gravar acontece **com a linha travada**: não há lost update. A `version` muda só quando o saldo muda (auditoria e `WalletBalanceChanged`), mas não é o mecanismo de concorrência.
- **Rejeição de negócio faz commit:** saldo insuficiente, player/moeda divergentes, problemas de referência viram `REJECTED` com `failureCode`, gravados junto com o evento `WagerTransactionRejected` (auditável), sem lançamento nem mudança de saldo. Exceções (rollback) ficam para payload inválido, wallet inexistente, conflitos de idempotência e falhas de infraestrutura.
- **Atomicidade:** inbox (via SQS), transação, lançamento, saldo/version e eventos da outbox são escritos na mesma transação SQL; nada é publicado no SQS nesse momento. O método `protected beforeCommit()` (vazio em produção) existe para os testes simularem uma falha depois de todas as escritas e provarem o rollback total.
- **Avaliação única:** `ProcessWagerTransaction.evaluate()` concentra as regras (wallet, referência, reversão, efeito no saldo) e é usada na entrada nova (HTTP e SQS) e no reprocessamento de `PENDING_REFERENCE`. Ela só faz leituras; as escritas acontecem depois.
- **Pool:** `DB_POOL_MAX` (padrão 10). Uma operação esperando o lock segura uma conexão, então o pool deve ser maior que o paralelismo esperado por instância.

## 6. Idempotência

Tudo no PostgreSQL; nenhum cache em memória participa (provado com 3 processos independentes).

**Algoritmo do `payloadHash`** (`src/wagering/payload-hash.ts`, a mesma função para HTTP e SQS):
1. Objeto só com os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (normalizado pelo `Money`) e `referenceExternalTransactionId` (quando houver).
2. JSON canônico: chaves ordenadas recursivamente, sem espaços, campos `undefined` omitidos.
3. SHA-256 do texto UTF-8, em hexadecimal.
- Ficam **fora**: header `Idempotency-Key`, `messageId`, `occurredAt`, `correlationId`, `causationId` e campos extras.

**Chave:** na API, o header `Idempotency-Key` é obrigatório e é a fonte da verdade (corpo com outra chave → 400). Na fila, `data.idempotencyKey`.

**Fluxo dentro da transação SQL:**
1. (Só SQS) `INSERT` na inbox `ON CONFLICT DO NOTHING`; se não inseriu, é redelivery: nada é reprocessado (§9.1).
2. `FOR UPDATE` na wallet.
3. Busca por `idempotency_key`: hash igual → **replay**; hash diferente → **409 `IDEMPOTENCY_KEY_CONFLICT`**.
4. Decide a operação **em memória**, sem escrever nada.
5. `INSERT INTO wager_transactions ... ON CONFLICT DO NOTHING RETURNING id` — **antes** de qualquer escrita de saldo, ledger ou outbox.
6. Se não inseriu (corrida que o lock não cobre: mesma chave em **wallets diferentes**, ou mesmo `externalTransactionId` com outra chave), o PostgreSQL já esperou o commit da outra transação: relê por chave (replay ou 409) ou por `(provider_id, external_transaction_id)` → **409 `DUPLICATE_EXTERNAL_TRANSACTION`**. Nenhum saldo muda (teste determinístico com a segunda transação comprovadamente esperando no `INSERT`).
7. Só se inseriu: lançamento, saldo/version e outbox, no mesmo commit.

**Replay devolve o resultado original:** `PROCESSED` com o saldo **da época**, `REJECTED` com o mesmo `failureCode` (422), `PENDING_REFERENCE` com o estado atual (202, ou 200 se o worker já resolveu). Sempre `idempotentReplay: true`.

## 7. API e mapeamento HTTP

**Endpoints:** `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?cursor&limit`, `POST /wallets/:walletId/reconciliation`, `POST /wagering/transactions`, `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `GET /health/live`, `GET /health/ready`, `GET /metrics`.

Mapeamento único para todos os endpoints (`src/http-exception.filter.ts`); corpo de erro `{ code, message, retryable, failureCode? }`:

| Situação | HTTP | `code` | `retryable` | O provedor deve… |
|---|---|---|---|---|
| Wallet criada | 201 | — | — | — (o único 201: criação de recurso) |
| Transação `PROCESSED` (original **ou** replay) | 200 | — | — | `idempotentReplay` diz se é replay |
| Transação em `PENDING_REFERENCE` | 202 | — | — | consultar depois |
| Rejeição de negócio (`REJECTED`) | 422 | `BUSINESS_RULE_REJECTED` + `failureCode` | false | ver §8.2 |
| Payload inválido, header ausente, cursor/limit inválido, JSON malformado, `OPENING` pela API | 400 | `INVALID_PAYLOAD` | false | corrigir o payload |
| Wallet / transação / rota inexistente | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` | false | corrigir o id |
| Mesma chave com outro payload | 409 | `IDEMPOTENCY_KEY_CONFLICT` | false | usar outra chave |
| Mesmo `(providerId, externalTransactionId)` com outra chave | 409 | `DUPLICATE_EXTERNAL_TRANSACTION` | false | reenviar com a chave original |
| Wallet duplicada (player + moeda) | 409 | `WALLET_ALREADY_EXISTS` | false | usar a wallet existente |
| Falha transitória de infraestrutura | 503 + `Retry-After: 2` | `SERVICE_UNAVAILABLE` | true | reenviar a mesma requisição |
| Erro inesperado | 500 | `INTERNAL_ERROR` | false | contatar a operação |

- No 422 o corpo traz também o resultado gravado (`transactionId`, `status`, `balance`, `idempotentReplay`), para o replay ser idêntico ao original.
- **200, não 201, para transações:** o mesmo pedido pode ser original ou replay e deve ter a mesma resposta; `idempotentReplay` diferencia.
- **503 em vez de 500 ou de travar:** o pool do `pg` recebe `connectionTimeoutMillis` (`DB_CONNECT_TIMEOUT_MS`) e `query_timeout` (`DB_QUERY_TIMEOUT_MS`); `src/infrastructure-errors.ts` classifica como transitórios os erros de conexão, timeout, deadlock e serialização. A mesma classificação decide retry × DLQ no consumidor.
- **Cursor do ledger:** keyset na coluna `seq` (identity); cursor opaco = JSON `{ seq }` em base64url; `limit` padrão 50, máximo 100. Lançamentos da mesma wallet são inseridos sob o lock da wallet, então a ordem do `seq` é a ordem de commit e não depende do relógio das instâncias.

## 8. Regras de negócio e interpretações

### 8.1 Efeito de cada operação

| Operação | Referência | Efeito no saldo | Ledger | Eventos |
|---|---|---|---|---|
| `OPENING` (interna, criação de wallet com saldo > 0) | — | define o saldo inicial | 1 `CREDIT` (0 → saldo inicial) | Processed + BalanceChanged |
| `BET` | proibida (400) | débito; sem saldo → `REJECTED INSUFFICIENT_FUNDS` | 1 `DEBIT` | Processed + BalanceChanged / Rejected |
| `WIN` | opcional (BET da mesma rodada) | crédito (valor livre) | 1 `CREDIT` | Processed + BalanceChanged |
| `LOSS` | opcional (BET da mesma rodada) | nenhum | nenhum | Processed |
| `REFUND` | obrigatória, só BET `PROCESSED`, mesmo valor | crédito | 1 `CREDIT` | Processed + BalanceChanged |
| `ROLLBACK` de BET | obrigatória, mesmo valor | crédito | 1 `CREDIT` | Processed + BalanceChanged |
| `ROLLBACK` de WIN ou REFUND | obrigatória, mesmo valor | débito; sem saldo → `REJECTED REVERSAL_INSUFFICIENT_FUNDS` | 1 `DEBIT` | Processed + BalanceChanged / Rejected |
| referência ausente ou não terminada | — | nenhum (por enquanto) | nenhum | PendingReference (HTTP 202) |

**Validação da referência** (`WagerTransaction.checkReference`, a mesma para WIN, LOSS, REFUND e ROLLBACK): resolvida por `(providerId da transação, referenceExternalTransactionId)`; mesmo provider, player, wallet, moeda e rodada (senão `REFERENCE_MISMATCH`); tipo permitido (`INVALID_REFERENCE_KIND`); referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`; ainda pendente → aguarda; em reversões, valor igual (`AMOUNT_MISMATCH`). Antes, `playerId` e moeda são conferidos contra a wallet (`PLAYER_MISMATCH`, `CURRENCY_MISMATCH`).

### 8.2 Taxonomia de `failureCode`

| Código | Quando | O provedor deve reenviar? |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Não (a mesma operação seria rejeitada de novo) |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN/REFUND deixaria o saldo negativo | Não; exige tratamento operacional |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | Não; corrigir o payload (nova chave) |
| `PLAYER_MISMATCH` | `playerId` ≠ dono da wallet | Não; corrigir o payload (nova chave) |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro da janela de `PENDING_REFERENCE` | Sim, depois de enviar a referência, com nova chave |
| `REFERENCE_NOT_PROCESSED` | referência foi `REJECTED`/`FAILED` (ou nunca terminou na janela) | Não; não há o que reverter |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/moeda/rodada | Não; corrigir o payload |
| `INVALID_REFERENCE_KIND` | tipo de referência não permitido (ex.: REFUND de WIN) | Não; corrigir o payload |
| `AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | Não; corrigir o payload |
| `ALREADY_REVERSED` | a referência já tem uma reversão processada | Não; já revertida |
| `INTERNAL_ERROR` | status `FAILED`: erro inesperado e não recuperável (§9.3) | Não automaticamente; contatar a operação |

Payload inválido, conflito de idempotência e wallet inexistente **não** são `failureCode`: são respostas HTTP (400/409/404) — ou DLQ, via fila — e nada é gravado.

### 8.3 Interpretações adotadas

| Tema | Decisão | Justificativa / trade-off |
|---|---|---|
| Reversões (regra 7.4) | **Leitura estrita:** uma referência aceita no máximo **uma** reversão processada (REFUND **ou** ROLLBACK). Checado dentro do lock da wallet → `REJECTED ALREADY_REVERSED` com commit; o índice único parcial é a última barreira. ROLLBACK de um REFUND continua permitido (a referência é outra transação). | Com a leitura literal ("pelo mesmo tipo"), uma BET poderia receber REFUND **e** ROLLBACK e creditar duas vezes, violando "não duplicar créditos". Trade-off: um provedor que envie as duas recebe rejeição na segunda. |
| BET com `referenceExternalTransactionId` | 400 | O enunciado não prevê referência em BET. |
| WIN / LOSS com referência | opcional; mesma validação; referência ausente → `PENDING_REFERENCE` | "WIN pode referenciar a BET"; LOSS é o outro resultado da mesma BET. Sem igualdade de valor (a regra 5 é só para reversões). |
| Referência de outro provider | não é encontrada → `PENDING_REFERENCE` e, se nunca aparecer, `REFERENCE_NOT_FOUND` | Uma referência nunca cruza provedores. |
| Wallet inexistente | HTTP 404; via SQS → DLQ (erro permanente) | Não existe wallet onde registrar a transação. |
| Fila de eventos | `wallet-events.fifo` | O enunciado lista só a fila de entrada e a DLQ, mas exige publicar eventos. Publicar na fila de entrada misturaria comandos e eventos (o consumidor teria de ignorar mensagens e um evento ruim poderia ir para a DLQ de transações). |

### 8.4 `PENDING_REFERENCE`

- Referência ausente (ou existente mas ainda pendente) → a transação é gravada como `PENDING_REFERENCE`, com evento `WagerTransactionPendingReference` e HTTP 202. Por isso a corrente ROLLBACK → REFUND → BET chegando ao contrário resolve na ordem certa.
- **Worker** (`src/wagering/pending-reference.worker.ts`): loop com `setTimeout` encadeado (sem dependência nova), iniciado em `onModuleInit` e parado em `onModuleDestroy` (espera o ciclo em andamento). Configurável por `PENDING_REFERENCE_*`.
- **Backoff:** colunas `reference_attempts` e `next_reference_attempt_at`; atraso = base × 2^tentativas = 2s, 4s, 8s, 16s, 32s, 64s. Após 6 reavaliações (~126 s ≈ **2 min**) → `REJECTED REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED`, se a referência existe mas nunca terminou) + evento `WagerTransactionRejected`.
- **Trade-off da janela de ~2 min:** libera o estado rápido, mas uma referência que chegue depois não é casada. Em produção a janela seria calibrada pelo SLA de reenvio dos provedores (variável de ambiente).
- **Ordem de locks igual à do caminho principal:** a seleção das vencidas é só uma lista de candidatas, sem lock. Para cada uma: transação SQL → `FOR UPDATE` na **wallet** → **relê** a transação → confere que ainda está pendente e vencida → reavalia com a mesma `evaluate()` → grava e faz commit. Se outro worker ou instância já resolveu, a releitura vê isso e não faz nada. Dois workers nunca aplicam o mesmo efeito (testado).
- Eventos de transações resolvidas pelo worker usam a própria transação como `correlationId`/`causationId` (a requisição original não é gravada).

## 9. Mensageria (SQS)

Filas FIFO criadas por `scripts/create-queues.ts` (idempotente, serviço `sqs-init` do Compose): `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount = 5`) e `wallet-events.fifo` (saída, §8.3).

### 9.1 Consumidor (`src/messaging/wager-transaction.consumer.ts`)

Provider NestJS dentro da app, ligado por `SQS_CONSUMER_ENABLED`. Long polling, lote pequeno, mensagens processadas uma a uma:

1. Valida o envelope do enunciado (`messageId`, `type = WagerTransactionRequested`, `occurredAt`, `data.idempotencyKey`) e o `data` com a **mesma** validação da API.
2. Chama o **mesmo** `ProcessWagerTransaction` da API. O `messageId` vira `correlationId`/`causationId` dos eventos e **não** entra no `payloadHash`.
3. **Inbox na mesma transação SQL:** `INSERT ... ON CONFLICT DO NOTHING` em `(consumer_name, message_id)` é o primeiro comando da transação; rollback desfaz a inbox também. Se não inseriu, é redelivery: nada é reprocessado. Duas entregas simultâneas: a segunda espera o commit da primeira nesse `INSERT`. Mesmo `messageId` com outro payload → erro permanente.
4. **Ack (`DeleteMessage`) só depois do commit.** Se o ack falhar, a mensagem volta após o visibility timeout e a inbox a reconhece.

### 9.2 Classificação de erros, backoff e DLQ

| Tipo | Exemplos | Ação |
|---|---|---|
| Resultado de negócio (terminal) | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, redelivery | commit → ack |
| Transitório | banco indisponível, timeout, deadlock, falha temporária do SQS | sem ack; `ChangeMessageVisibility` com backoff |
| Permanente | JSON/envelope inválido, `type` desconhecido, payload inválido (inclui `OPENING`), wallet inexistente, conflito de idempotência, external duplicado, conflito de inbox | envia à DLQ (atributos `reason` e `error`) e **só então** apaga; log `error` + `sqs_dead_lettered_total{reason}` |
| Inesperado (bug) | erro desconhecido | retry com backoff; na **última** tentativa grava `FAILED` e envia à DLQ (§9.3) |

**Backoff × `maxReceiveCount`:** atraso = `SQS_CONSUMER_RETRY_BASE_DELAY_SECONDS × 2^(ApproximateReceiveCount − 1)`, limitado a `SQS_CONSUMER_RETRY_MAX_DELAY_SECONDS`. Com os padrões (base 2s) e `maxReceiveCount = 5`: 2s, 4s, 8s, 16s; a 5ª falha agenda 32s e, no recebimento seguinte, a redrive policy move a mensagem para a DLQ — cerca de 1 minuto de tolerância. A contagem é do próprio SQS, então vale entre instâncias e reinícios. `SQS_CONSUMER_MAX_RECEIVE_COUNT` deve ser igual ao da redrive policy (é como o consumidor reconhece a última tentativa).

### 9.3 Status `FAILED`

Gravado só pelo consumidor, quando um erro **inesperado e não transitório** (um bug, uma violação de constraint imprevista) persiste até a última tentativa: a transação é registrada como `FAILED` com `INTERNAL_ERROR` numa **transação SQL separada** (sem lançamento nem saldo; não grava se a wallet não existe ou se a chave já tem transação), com log `error` e métrica, e a mensagem vai para a DLQ com motivo `PROCESSING_FAILED`. Não há evento de integração para `FAILED` (não está na lista mínima do enunciado). Na API, o mesmo tipo de erro vira HTTP 500 sem gravar `FAILED`: o cliente síncrono recebe o erro na hora e pode reenviar (a idempotência protege). Erros transitórios não geram `FAILED` (o banco pode estar fora); eles vão para a DLQ pela redrive policy.

### 9.4 Encerramento (SIGTERM)

`src/main.ts` trata `SIGTERM`/`SIGINT` chamando `app.close()`, que executa os hooks dos módulos: o consumidor para de buscar (aborta o long polling), devolve a visibilidade (`VisibilityTimeout = 0`) das mensagens recebidas e não iniciadas e espera a mensagem em andamento até `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS`; o publicador e o worker esperam o ciclo atual; o pool do banco fecha. Depois o processo sai com **código 0** (1 se o fechamento falhar). Se o prazo esgotar com mensagem em andamento, há log `warn`: a transação commita (e a reentrega vira redelivery na inbox) ou é desfeita (e a mensagem é reprocessada).

**Falha injetada (recurso de teste):** `FAULT_CRASH_AFTER_COMMIT=1` faz o consumidor chamar `process.exit(1)` logo depois do commit e antes do ack. Lida só da variável de ambiente, inerte por padrão, usada no teste do cenário "processo morto depois do commit e antes do ack". Nunca definir em produção.

### 9.5 Publicador da outbox (`src/messaging/outbox-publisher.ts`)

Loop agendado na app (`OUTBOX_*`). Cada ciclo é **uma transação SQL**:

```sql
select ... from outbox_messages
 where published_at is null and (next_attempt_at is null or next_attempt_at <= :now)
 order by occurred_at, id limit :batch
 for update skip locked;
-- para cada linha: SendMessage (corpo = envelope, MessageGroupId = walletId, MessageDeduplicationId = eventId)
--   sucesso → published_at = now;  falha → attempts + 1 e next_attempt_at com backoff
commit;
```

- **Nada é publicado antes do commit do negócio:** o publicador só enxerga linhas já commitadas na outbox (testado com uma transação parada antes do commit).
- **Vários publicadores:** `SKIP LOCKED` faz cada um pegar um lote diferente (testado: 2 publicadores, 60 eventos, cada um enviado exatamente uma vez).
- **Crash:** se o processo morre depois do envio e antes do commit, a transação é desfeita e outro publicador reenvia. Entrega **at-least-once**: o `MessageDeduplicationId = eventId` costuma absorver o reenvio no broker (janela de 5 min do FIFO), mas o consumidor de eventos deve deduplicar pelo `eventId` (testado com duplicata forçada e um consumidor que deduplica pela inbox).
- **Falha de envio:** o evento é reagendado e **nunca** marcado como publicado sem ter sido enviado.
- **Trade-off — transação aberta durante o envio:** segura o lock do lote enquanto chama o SQS. Vantagem: simples e seguro (não há estado "reservado" para recuperar; morreu, desfez). Custo: conexões e locks presos durante chamadas de rede; mitigado por lotes pequenos e timeouts. Alternativa não adotada: reservar o lote com prazo, publicar fora da transação e confirmar depois.
- **Ordem dos eventos é best-effort:** com dois publicadores ou um evento em retry, eventos da mesma wallet podem sair fora de ordem. O consumidor deduplica pelo `eventId` e ordena pelo `walletVersion` quando precisar.

## 10. Observabilidade

**Logs:** JSON pelo `ConsoleLogger` do NestJS (`json: true`). Campos de rastreio: `correlationId` (header `x-correlation-id` ou gerado; via SQS é o `messageId`), `messageId`, `transactionId`, `walletId`, `providerId`, além de `kind`, `status`, `failureCode`. **Sem** valores monetários, payload completo, connection string ou credenciais (testado capturando os logs de uma transação via API e via fila). A única quantia logada é a `difference` de uma reconciliação divergente, como diagnóstico.

**Métricas** (`GET /metrics`, Prometheus, `prom-client` com registry próprio):

| Exigência do enunciado | Métrica |
|---|---|
| Transações por status | `wager_transactions_total{kind,status}` (inclui `PENDING_REFERENCE`, `FAILED` e as resolvidas pelo worker; replays não contam); `wager_transactions_pending_reference` (gauge) |
| Duplicatas detectadas | `idempotency_duplicates_total{type}` (`replay`, `idempotency_key_conflict`, `duplicate_external_transaction`, `inbox`, `inbox_payload_conflict`) |
| Retries | `sqs_consumer_retries_total`, `pending_reference_retries_total{outcome}`, `outbox_publish_failures_total` |
| Mensagens em DLQ | `sqs_dead_lettered_total{reason}` (enviadas pelo consumidor); `sqs_dead_letter_queue_messages` (profundidade real da DLQ, lida do SQS no scrape; inclui as movidas pela redrive policy; `-1` se o SQS estiver fora) |
| Conflitos de lock | `wallet_lock_conflicts_total` |
| Outbox lag | `outbox_lag_seconds` (idade do evento não publicado mais antigo) |
| Latência de processamento | `wager_transaction_processing_seconds{kind}` (histograma; inclui a espera pelo lock) |
| Outras | `sqs_messages_consumed_total{outcome}`, `outbox_events_published_total{eventType}`, `reconciliation_mismatches_total` |

**Health:** `/health/live` (processo vivo) e `/health/ready` (`select 1` no PostgreSQL + `GetQueueUrl` no SQS, timeout de 2 s cada; **503** se algum falhar, com log `warn` do motivo). O readiness usa `select 1` porque o `checkConnection()` do MikroORM 7 não vai ao banco enquanto o pool não abriu conexão.

**Reconciliação** (`POST /wallets/:walletId/reconciliation`): uma única consulta lê o saldo armazenado e soma créditos e débitos do ledger (mesmo snapshot). Divergência gera log `error`, incrementa `reconciliation_mismatches_total` e é sinalizada na resposta; **nunca é corrigida**.

## 11. Patch local no kysely 0.29.6

- **Bug:** em `ControlledTransactionBuilder.execute()` (kysely 0.29.6, usado pelo MikroORM 7.2.5; era também a versão mais recente publicada), a conexão é obtida do pool e, se o `BEGIN` falha (ex.: timeout com o banco sem responder), ela nunca é liberada.
- **Medição antes do patch:** 1 conexão presa por requisição feita com o banco pausado, também depois de o banco voltar. Após `DB_POOL_MAX` falhas a instância só respondia 503 até reiniciar, e o shutdown esperava para sempre.
- **Patch** (`patches/kysely@0.29.6.patch`, em `patchedDependencies` do `package.json`; o `Dockerfile` copia `patches/` antes do `bun install`): (1) libera a conexão quando o `BEGIN` falha; (2) devolve ao `pg-pool` **com erro** (para ser descartada) toda conexão que teve erro do lado do cliente — timeout ou conexão perdida, erros sem `severity`. O item (2) evita reutilizar uma conexão em estado desconhecido (por exemplo, com um `BEGIN` que o servidor ainda vai executar ao voltar de uma pausa, deixando uma transação aberta para a próxima requisição).
- **Teste:** `test/integration/database-unavailable.test.ts` — mais falhas de `BEGIN` do que o tamanho do pool com o banco pausado; quando ele volta, nenhuma conexão presa e resposta 200 sem reiniciar. Sem o patch, o mesmo teste falha.
- **Remover** quando o kysely corrigir o `ControlledTransactionBuilder` e o MikroORM passar a depender dessa versão.

## 12. Limitações e trade-offs conhecidos

- **Autenticação não implementada** (§13).
- **Patch local em dependência** (§11), a remover quando o upstream corrigir.
- **Janela de `PENDING_REFERENCE` de ~2 min:** referências que cheguem depois não são casadas (configurável).
- **Ordem dos eventos publicados é best-effort**; entrega at-least-once (consumidores deduplicam por `eventId`).
- **Publicador segura a transação durante o envio ao SQS** (simplicidade × conexões presas em chamadas de rede).
- **Erros inesperados na API** viram 500 sem registrar `FAILED`; no consumidor, `FAILED` só na última tentativa.
- **`numeric(20,2)` arredonda** valores com mais de 2 casas em vez de recusá-los; o `Money` é o único caminho de escrita e rejeita esses valores antes.
- **"Toda alteração de saldo tem lançamento"** é garantido pelo agregado e verificado pela reconciliação, não por constraint.
- **Testado com o MiniStack**, não contra AWS SQS real.
- **Não testado:** volume alto (não há teste de carga), SIGTERM com mensagem que ultrapassa o `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS` (o caminho existe e loga `warn`).

## 13. Autenticação

Não implementada: não pontua no enunciado e competiria com correção financeira, concorrência e idempotência. Ponto de extensão: `src/auth/provider-auth.guard.ts` (`ProviderAuthGuard`, hoje libera tudo), aplicado aos controllers de negócio e nunca aos de health/métricas.

**Desenho previsto:** cada provedor é um client OAuth2 (client credentials) num IdP externo no Compose (Keycloak ou Zitadel). O guard valida o JWT (assinatura via JWKS, `iss`, `aud`, expiração) e expõe a identidade do provedor (claim com o `providerId`) por uma porta simples (`ProviderIdentity`), que o controller compara com o `providerId` do payload (divergência → 403). Mensagens da fila são canal interno confiável, mas o `providerId` delas continua passando pelas mesmas validações de domínio.

## 14. Testes e ambiente

| Tipo | Onde | O que cobre |
|---|---|---|
| Unitários (`test/unit`) | local ou container | `Money`, `Wallet`, transições, regras por kind, referências, hash canônico, parsing, cursor, backoff, varredura estática "dinheiro nunca vira number" |
| Integração (`test/integration`) | container | migrations, constraints, atomicidade (inclusive inbox), API e contratos HTTP, idempotência, ledger, reconciliação, referências, consumidor, DLQ, publicador, banco indisponível, observabilidade |
| Concorrência e processos (`test/concurrency`, `test/process`) | container | cenários §8 e §13 #1–#8 com paralelismo real, 3 instâncias, crash, SIGTERM, reinício |

- PostgreSQL e SQS **reais** (containers); nada é mockado. Banco `wagering_test` (o helper recusa banco que não termine em `_test`) e filas com prefixo único por arquivo.
- Cada teste cria seus próprios dados (ids novos); não há limpeza entre testes e nenhum trigger ou constraint é desligado. Ao fim de cada arquivo de integração/concorrência: saldo = créditos − débitos = último `balance_after` para cada wallet tocada.
- O **Windows não entrega `SIGTERM`** a processos filhos (medido); por isso a suíte completa roda no container Linux (`docker compose run --rm tests`).
- Banco indisponível dentro do container: `test/support/tcp-proxy.ts` descarta os bytes entre app e PostgreSQL (mesmo efeito de `docker compose pause`); o `pause` real foi verificado manualmente.
- Processos reais (`test/support/instances.ts`) para 3 instâncias, crash após commit, SIGTERM e reinício. Arquivos que conferem a fila de eventos marcam como publicados, no banco de teste, os eventos acumulados por outros arquivos.

## 15. Checklist dos eliminatórios

| Eliminatório | Como é garantido | Teste que prova |
|---|---|---|
| `number` para dinheiro | `Money` sobre `decimal.js`, entrada só por string; `numeric(20,2)` lido como string; contratos e eventos com string decimal | `test/unit/no-number-money.test.ts` › "dinheiro nunca vira number" (3 testes); `test/unit/money.test.ts` › "rejeita amount que não é string (ex.: number)"; `test/integration/wagering-api.test.ts` › "400 INVALID_PAYLOAD: amount como number"; `test/integration/outbox-publisher.test.ts` › "os 4 tipos de evento chegam na fila com version, dinheiro em string decimal…" |
| Saldo negativo causado por race | `FOR UPDATE` por wallet + `CHECK (balance >= 0)` + `canDebit` no agregado | `test/concurrency/wallet-concurrency.test.ts` › "cenário obrigatório §8: saldo 100, duas BET de 80 simultâneas" e "50 BETs de 1.00 simultâneas com saldo 30.00…"; `test/concurrency/multi-instance.test.ts` › "rajada distribuída entre 3 processos…"; `test/integration/schema-constraints.test.ts` › "saldo negativo é recusado na inserção e na atualização" |
| Débito ou crédito duplicado | idempotência no banco (`UNIQUE` + `ON CONFLICT`), inbox, regra de reversão única, índice único parcial | `test/concurrency/same-key-http.test.ts` › "a mesma aposta enviada 50 vezes em paralelo por HTTP → um único débito"; `test/integration/idempotency.test.ts` › "determinístico: B chega ao INSERT ON CONFLICT…"; `test/concurrency/reversals-concurrency.test.ts` › "REFUND e ROLLBACK da mesma BET em paralelo…"; `test/integration/sqs-consumer.test.ts` › "redelivery: o mesmo messageId entregue duas vezes…"; `test/concurrency/sqs-processes.test.ts` › "a reentrega é reconhecida pela inbox…" |
| Idempotência apenas em memória | chaves, hashes e inbox só no PostgreSQL | `test/concurrency/multi-instance.test.ts` › "rajada distribuída entre 3 processos, com chaves repetidas…" (respostas idênticas por chave entre processos); `test/concurrency/sqs-processes.test.ts` › "wallet disputada por 3 consumidores com mensagens duplicadas…" |
| Solução correta somente com uma instância | todas as garantias estão no banco (locks, constraints, inbox, outbox com `SKIP LOCKED`) | `test/concurrency/multi-instance.test.ts`; `test/concurrency/sqs-processes.test.ts` › "3 processos consumindo a mesma fila" e "kill das instâncias no meio da carga…"; `test/concurrency/outbox-publishers.test.ts` › "60 eventos publicados por 2 publishers simultâneos…" |
| Publicação de evento antes do commit | eventos só na outbox, na transação de negócio; publicador lê só o commitado | `test/integration/outbox-publisher.test.ts` › "com a transação de negócio parada antes do commit, o publisher não publica nada dela…"; `test/integration/process-wager-transaction.test.ts` › "falha após atualizar o saldo e antes do commit: rollback total…" |
| Ausência de ledger auditável | lançamento por movimentação, append-only por trigger, aritmética por `CHECK`, consulta paginada, reconciliação | `test/integration/schema-constraints.test.ts` › "UPDATE é recusado pelo trigger", "DELETE…", "TRUNCATE…"; `test/integration/ledger-pagination.test.ts`; `test/integration/reconciliation.test.ts` › "saldo corrompido…: divergência sinalizada, logada, contada e NÃO corrigida"; invariante saldo = ledger no fim de todos os arquivos |
| Testes que substituem PostgreSQL e SQS por mocks | nenhum mock: `test/support/app.ts` sobe a app real no PostgreSQL real; `test/support/sqs.ts` cria filas reais no emulador | todos os arquivos de `test/integration` e `test/concurrency` (ex.: `test/integration/migrations.test.ts`, `test/integration/sqs-consumer.test.ts`); nenhum uso de mock/spy no diretório `test/` |
