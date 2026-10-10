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
| Agendamento de `PENDING_REFERENCE` coerente | `wager_transactions_pending_reference_scheduled`: `(status = PENDING_REFERENCE) = (next_reference_attempt_at is not null)`; `reference_attempts >= 0`; índice parcial nas vencidas |
| Ordem estável do ledger | `seq bigint generated always as identity` (único), índice `(wallet_id, seq)` |

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

**Avaliação única.** `ProcessWagerTransaction.evaluate()` concentra as regras (wallet, referência, reversão, efeito no saldo) e é usada tanto na entrada nova quanto no reprocessamento de `PENDING_REFERENCE` (§6.1). Ela só faz leituras no banco; as escritas acontecem depois, pelo chamador.

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
- **`wallet-events.fifo` é uma interpretação.** O enunciado (§10) lista apenas `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, mas exige que a outbox publique eventos de integração (§11) sem dizer onde. Publicar os eventos na própria `wager-transactions.fifo` misturaria comandos de entrada com eventos de saída: o consumidor teria de ignorar mensagens que não são `WagerTransactionRequested`, e um evento malformado poderia ir parar na DLQ de transações. Por isso, uma fila separada só para saída. `MessageGroupId` = `aggregateId` (walletId); `MessageDeduplicationId` = `eventId` reduz duplicatas na janela de 5 min do SQS — os consumidores ainda devem deduplicar pelo `eventId`.

### 5.1 Consumidor (`src/messaging/wager-transaction.consumer.ts`) — implementado (Fase 6)

Roda dentro da app (provider NestJS), ligado por `SQS_CONSUMER_ENABLED`. Long polling (`SQS_CONSUMER_WAIT_TIME_SECONDS`), lote pequeno (`SQS_CONSUMER_BATCH_SIZE`), mensagens processadas uma a uma.

1. Valida o envelope do enunciado (`messageId`, `type = WagerTransactionRequested`, `occurredAt`, `data` com `idempotencyKey`) e o `data` com a **mesma** função de validação da API (`parseWagerPayload`).
2. Chama o **mesmo** `ProcessWagerTransaction` da API (`executeFromMessage`), com `idempotencyKey = data.idempotencyKey`. O `messageId` vira `correlationId`/`causationId` dos eventos, mas **não** entra no `payloadHash`.
3. **Inbox na mesma transação SQL** do processamento: `INSERT INTO inbox_messages ... ON CONFLICT DO NOTHING` em `(consumer_name, message_id)` é o primeiro comando da transação, junto com wallet, transação, ledger e outbox. Rollback desfaz a inbox também. Se não inseriu, é **redelivery**: nada é reprocessado e a mensagem é confirmada. Com duas entregas simultâneas, a segunda espera o commit da primeira nesse INSERT. A inbox guarda o `payload_hash`; mesmo `messageId` com outro payload → erro permanente.
4. **Ack (`DeleteMessage`) só depois do commit.** Se o ack falhar, a mensagem volta após o visibility timeout e a inbox a reconhece.

**Classificação de erros:**

| Tipo | Exemplos | Ação |
|---|---|---|
| Resultado de negócio (terminal) | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay de idempotência, redelivery (inbox) | commit → ack |
| Transitório | banco indisponível, timeout, deadlock, falha temporária do SQS (`isTransientInfrastructureError`) | sem ack; `ChangeMessageVisibility` com backoff |
| Permanente | JSON inválido, envelope inválido, `type` desconhecido, payload inválido (inclui `OPENING`), wallet inexistente, conflito de idempotência, `externalTransactionId` duplicado, conflito de inbox | `SendMessage` na DLQ (com atributos `reason` e `error`) e **só então** `DeleteMessage`; log `error` + métrica `sqs_dead_lettered_total{reason}` |
| Inesperado (bug, erro desconhecido) | — | tratado como transitório: retry com backoff, limitado pela redrive policy |

**Backoff × `maxReceiveCount`:** atraso = `SQS_CONSUMER_RETRY_BASE_DELAY_SECONDS × 2^(ApproximateReceiveCount − 1)`, limitado a `SQS_CONSUMER_RETRY_MAX_DELAY_SECONDS`. Com os padrões (base 2s, máximo 60s) e `maxReceiveCount = 5`: as 4 primeiras falhas devolvem a mensagem após 2s, 4s, 8s e 16s; a 5ª falha agenda mais 32s e, no recebimento seguinte, a redrive policy move a mensagem para a DLQ — cerca de 1 minuto de tolerância a indisponibilidade antes da DLQ. A contagem é do próprio SQS (não depende de memória do processo), então vale entre instâncias e reinícios.

**SIGTERM:** o hook `onModuleDestroy` (com `enableShutdownHooks`) para de buscar mensagens (aborta o long polling), devolve a visibilidade (`VisibilityTimeout = 0`) das mensagens recebidas e ainda não iniciadas e espera a mensagem em andamento até `SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS`. Se o tempo esgotar, loga `warn` e segue o shutdown; a transação em andamento ou commita (e a reentrega vira redelivery na inbox) ou é desfeita (e a mensagem é reprocessada). O processo termina pelo próprio NestJS, que reemite o `SIGTERM` após fechar o app (código 143 — medido).

**Falha injetada (recurso de teste):** `FAULT_CRASH_AFTER_COMMIT=1` faz o consumidor chamar `process.exit(1)` logo depois do commit e antes do ack. Lida só da variável de ambiente, inerte por padrão, usada no teste do cenário §13 #5. Nunca definir em produção.

**Ordem:** o provedor escolhe o `MessageGroupId`; mensagens do mesmo grupo são entregues em ordem e uma de cada vez. A correção **não** depende disso: o lock da wallet, a idempotência e a inbox garantem o resultado mesmo com grupos diferentes ou entregas paralelas (testado com 3 processos).

### 5.2 Publisher da outbox (`src/messaging/outbox-publisher.ts`) — implementado (Fase 6)

Loop agendado dentro da app (`OUTBOX_PUBLISHER_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`). Cada ciclo é **uma transação SQL**:

```sql
select ... from outbox_messages
 where published_at is null and (next_attempt_at is null or next_attempt_at <= :now)
 order by occurred_at, id
 limit :batch
 for update skip locked;
-- para cada linha: SendMessage (corpo = envelope do evento, MessageGroupId = walletId,
--                  MessageDeduplicationId = eventId) → published_at = now
--                  falha no envio → scheduleRetry (attempts + 1, backoff 1s, 2s, 4s… até 5 min)
commit;
```

- **Nada é publicado antes do commit do negócio:** o publisher só enxerga linhas já commitadas na outbox.
- **Vários publishers:** `SKIP LOCKED` faz cada um pegar um lote diferente (testado: 2 publishers, 60 eventos, soma dos enviados = 60, cada evento exatamente uma vez na fila).
- **Crash:** se o processo morre depois do envio e antes do commit, a transação é desfeita, o lock cai e outro publisher reenvia. Entrega **at-least-once**: o `MessageDeduplicationId = eventId` costuma absorver o reenvio no broker (janela de 5 min do FIFO), mas o consumidor de eventos deve deduplicar pelo `eventId` — testado com uma duplicata forçada (mesmo evento com outro deduplication id) e um consumidor que deduplica pela inbox.
- **Falha de envio:** o evento é reagendado (`attempts`, `next_attempt_at`) e **nunca** marcado como publicado sem ter sido enviado.
- **Trade-off — transação aberta durante o envio:** a transação segura o lock das linhas do lote enquanto chama o SQS. Vantagem: simples e seguro (não existe estado "reservado" para limpar; morreu, desfez). Custo: conexões e locks presos durante chamadas de rede; por isso lotes pequenos e timeouts do pool. Alternativa (não adotada): marcar o lote como "em publicação" com prazo, publicar fora da transação e confirmar depois — mais escalável, mas exige recuperar reservas expiradas.
- **Ordem dos eventos é best-effort:** com 2 publishers em paralelo, ou com um evento em retry, eventos de uma mesma wallet podem sair fora de ordem. O consumidor deve deduplicar pelo `eventId` e ordenar pelo `walletVersion` (em `WalletBalanceChanged`) quando precisar.
- **Outbox lag:** gauge `outbox_lag_seconds` com a idade do evento não publicado mais antigo, atualizado a cada ciclo.

**Escolha do emulador — MiniStack em vez de LocalStack:**
- Desde a versão 2026.03.0, a imagem do LocalStack exige auth token de conta para iniciar; o avaliador também precisaria de conta. O enunciado aceita MiniStack, que é MIT e não exige conta.
- Antes de adotar, `scripts/check-sqs-emulator.ts` comprovou: ordem FIFO por `MessageGroupId` (e bloqueio do grupo com mensagem em voo), dedup por `MessageDeduplicationId`, `ChangeMessageVisibility`, reentrega após visibility timeout (com `ApproximateReceiveCount`) e redrive para DLQ via `maxReceiveCount`. Resultado: 6/6 PASS.
- Plano B, não utilizado: LocalStack fixado em tag anterior a 2026.03.

**Comportamento do MiniStack nos testes da Fase 6:** FIFO, deduplicação por `MessageDeduplicationId`, `ChangeMessageVisibility` (inclusive `0`), reentrega após visibility timeout, redrive para a DLQ por `maxReceiveCount` e atributos de mensagem funcionaram como no SQS; nenhuma divergência observada.

## 6. Regras de negócio — interpretações adotadas

| Tema | Decisão | Justificativa / trade-off |
|---|---|---|
| Reversões (regra 7.4) | **Leitura estrita:** uma referência aceita no máximo **uma** reversão (REFUND **ou** ROLLBACK), garantida por índice único parcial no banco. ROLLBACK de um REFUND continua permitido (a referência é outra transação). | Invariante global "não duplicar créditos": com a leitura literal ("pelo mesmo tipo"), uma BET poderia receber REFUND **e** ROLLBACK e creditar duas vezes. Trade-off: um provedor que envie as duas recebe rejeição na segunda. |
| BET com `referenceExternalTransactionId` | 400 (payload inválido) | O enunciado não prevê referência em BET. |
| WIN / LOSS com referência | Opcional; se presente, validada pela **mesma função** (mesmo provider, player, wallet, moeda e rodada, e deve ser uma BET). Referência ausente → `PENDING_REFERENCE`. | §7 "WIN pode referenciar a BET"; LOSS é o outro resultado da mesma BET. Sem igualdade de valor (regra 5 vale só para reversões). |
| `playerId` ou moeda do payload ≠ da wallet | `REJECTED` com `failureCode` próprio (`PLAYER_MISMATCH`, `CURRENCY_MISMATCH`) | Rejeição de negócio auditável. |
| Wallet inexistente | HTTP 404, nada é gravado; via SQS → DLQ | Não existe wallet onde registrar a transação. |
| Referência existe mas não está `PROCESSED` | `REJECTED`/`FAILED` → rejeita com `REFERENCE_NOT_PROCESSED`; ainda pendente → continua `PENDING_REFERENCE` (assim a corrente ROLLBACK → REFUND → BET resolve na ordem certa) | — |
| Referência de outro provider | Não é encontrada (a busca é por `(providerId da transação, referenceExternalTransactionId)`) → `PENDING_REFERENCE` e, se nunca aparecer, `REFERENCE_NOT_FOUND` | Uma referência nunca cruza provedores. |
| Reversão que deixaria saldo negativo | `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS` (≠ `INSUFFICIENT_FUNDS`), com commit, sem lançamento | Regra 7.9. |
| Segunda reversão da mesma referência | `REJECTED` `ALREADY_REVERSED`, com commit. Checado dentro do lock da wallet (a referência válida é da mesma wallet); o índice único parcial é só a última barreira | Regra estrita (acima). |
| `PENDING_REFERENCE` | Worker com backoff exponencial, até 6 tentativas (2s, 4s, …, 64s ≈ 2 min). Esgotado → `REJECTED` `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED`, se a referência existe mas nunca terminou) + evento. Configurável por variável de ambiente (testes usam valores curtos). | **Trade-off:** janela curta libera o estado rápido, mas uma referência que chegue depois de ~2 min não será casada. Em produção a janela seria calibrada pelo SLA de reenvio dos provedores. |

### 6.1 Efeito de cada operação (implementado na Fase 5)

| Operação | Referência | Efeito no saldo | Ledger | Eventos |
|---|---|---|---|---|
| `BET` | proibida (400) | débito; sem saldo → `REJECTED INSUFFICIENT_FUNDS` | 1 `DEBIT` | Processed + BalanceChanged / Rejected |
| `WIN` | opcional (BET da mesma rodada) | crédito | 1 `CREDIT` | Processed + BalanceChanged |
| `LOSS` | opcional (BET da mesma rodada) | nenhum | nenhum | Processed |
| `REFUND` | obrigatória, só BET `PROCESSED`, mesmo valor | crédito | 1 `CREDIT` | Processed + BalanceChanged |
| `ROLLBACK` de BET | obrigatória, mesmo valor | crédito | 1 `CREDIT` | Processed + BalanceChanged |
| `ROLLBACK` de WIN ou REFUND | obrigatória, mesmo valor | débito; sem saldo → `REJECTED REVERSAL_INSUFFICIENT_FUNDS` | 1 `DEBIT` | Processed + BalanceChanged / Rejected |
| referência ausente / não terminada | — | nenhum (por enquanto) | nenhum | PendingReference (HTTP 202) |

**Validação da referência** (função única `WagerTransaction.checkReference`, igual para WIN, LOSS, REFUND e ROLLBACK): mesmo provider, player, wallet, moeda e rodada (senão `REFERENCE_MISMATCH`); tipo permitido (`INVALID_REFERENCE_KIND`); referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`; ainda pendente → aguarda; em reversões, valor igual (`AMOUNT_MISMATCH`). Antes dela, `playerId` e moeda são conferidos contra a wallet (`PLAYER_MISMATCH`, `CURRENCY_MISMATCH`).

**Worker de `PENDING_REFERENCE`** (`src/wagering/pending-reference.worker.ts`):
- Loop com `setTimeout` encadeado (sem dependência nova), iniciado em `onModuleInit` e parado em `onModuleDestroy`, que espera o ciclo em andamento terminar. Intervalo (`PENDING_REFERENCE_POLL_INTERVAL_MS`), atraso base (`PENDING_REFERENCE_BASE_DELAY_MS`) e limite (`PENDING_REFERENCE_MAX_ATTEMPTS`) por variável de ambiente; `PENDING_REFERENCE_WORKER_ENABLED=false` desliga o loop (os testes chamam o ciclo diretamente).
- Colunas `reference_attempts` e `next_reference_attempt_at` em `wager_transactions`; `CHECK` garante que só (e sempre) uma transação `PENDING_REFERENCE` tem próxima tentativa agendada. Atraso = base × 2^tentativas (2s, 4s, 8s, 16s, 32s, 64s).
- **Ordem de locks igual à do caminho principal:** a seleção das vencidas é só uma lista de candidatas, sem lock. Para cada uma: abre transação SQL → `FOR UPDATE` na **wallet** → **relê** a transação → confere que ainda está `PENDING_REFERENCE` e vencida → reavalia com a mesma `evaluate()` → grava (status, ledger, saldo, outbox) e faz commit. Se outro worker/instância já resolveu ou reagendou, a releitura vê isso e não faz nada (`skipped`). Por isso dois workers nunca aplicam o mesmo efeito (testado com dois workers simultâneos sobre 20 pendências).
- Eventos de uma transação resolvida pelo worker usam a própria transação como `correlationId`/`causationId` (a requisição original não fica gravada).
- Replay de uma transação pendente devolve o estado atual (202 enquanto pendente, 200 depois de processada pelo worker, com o saldo do momento em que foi aplicada).
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
| Falha transitória de infraestrutura (banco fora, timeout, deadlock) | 503 + `Retry-After: 2` | `SERVICE_UNAVAILABLE` | true | reenviar a mesma requisição (idempotência garante 1 efeito) |
| Erro inesperado | 500 | `INTERNAL_ERROR` | false | contatar a operação |

**Corpo de erro único:** `{ code, message, retryable, failureCode? }`. No 422 o corpo traz, além disso, o resultado gravado (`transactionId`, `status`, `balance`, `idempotentReplay`), para que o replay seja idêntico ao original. Health checks mantêm o corpo próprio `{ status, checks }`.

**Por que 200 (e não 201) para transações:** o mesmo pedido pode ser original ou replay e o enunciado pede a mesma resposta nos dois casos; o campo `idempotentReplay` diferencia. 201 fica só para a criação de wallet.

**503 em vez de 500/travamento:** o pool do `pg` recebe `connectionTimeoutMillis` (`DB_CONNECT_TIMEOUT_MS`, padrão 5 s; também limita a espera por conexão livre) e `query_timeout` (`DB_QUERY_TIMEOUT_MS`, padrão 10 s). Assim, com o banco sem responder (ex.: `docker compose pause postgres`), a requisição falha em vez de travar. `src/infrastructure-errors.ts` classifica como transitório: `ConnectionException`/`DeadlockException`/`LockWaitTimeoutException` do MikroORM, códigos de rede (`ECONNREFUSED`, `ECONNRESET`, …), SQLSTATE de conexão/serialização (`08xxx`, `53300`, `57P01`, `40001`, `40P01`) e as mensagens de timeout do `pg`. A mesma função será usada pelo consumidor SQS (retry × DLQ).

**Ledger com cursor:** keyset na coluna `seq bigint generated always as identity` de `wallet_ledger_entries` (índice `(wallet_id, seq)`); cursor opaco = JSON `{ seq }` em base64url; `limit` padrão 50, máximo 100; cursor/limit inválido → 400. Lançamentos da mesma wallet são inseridos sob o lock da wallet, então a ordem do `seq` é a ordem de commit — não depende do relógio de nenhuma instância. Páginas seguintes não repetem nem pulam itens (testado com inserções entre páginas).

## 8. Autenticação — decidido: não implementar

Autenticação não pontua (enunciado §2). Ponto de extensão: `src/auth/provider-auth.guard.ts` (guard no-op). Desenho previsto: provedores autenticam via OAuth2 client credentials num IdP externo (Keycloak no Compose); o guard valida o JWT (assinatura via JWKS, `aud`, expiração) e exige que o `providerId` do token seja igual ao do payload. Health checks ficam sempre abertos; mensagens da fila são canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.

## 9. Observabilidade

**Implementado:** logs JSON pelo `ConsoleLogger` nativo do NestJS (`json: true`), sem dependência extra. `/health/live` (processo vivo) e `/health/ready` (`select 1` no PostgreSQL + `GetQueueUrl` no SQS, timeout de 2s cada; 503 se algum falhar). Cada check que falha gera log `warn` com o nome do check e `nome: mensagem` do erro (sem connection string ou credenciais), ex.: `{"level":"warn","message":{"message":"readiness check failed","check":"postgres","reason":"Error: timeout after 2000ms"}}`.
- O readiness usa `select 1` porque o `checkConnection()` do MikroORM 7 responde "Connection not established" sem ir ao banco enquanto o pool não abriu conexão.

**Logs das operações:** `{ message, correlationId, messageId, transactionId, walletId, providerId, kind, status, failureCode, idempotentReplay }` — sem valores monetários nem payload completo. `correlationId` vem do header `x-correlation-id` (ou é gerado); via SQS é o `messageId`.

**Métricas (`GET /metrics`, formato Prometheus) — `prom-client` 15.1.3.** Escolhido por ser o padrão de fato, pure JS (verificado rodando no Bun antes de adotar) e por já trazer histogramas com buckets, que seriam trabalhosos de escrever à mão. Usa um `Registry` próprio (não o global), para que vários apps no mesmo processo de teste não colidam.

| Métrica | Tipo | Desde |
|---|---|---|
| `wager_transactions_total{kind,status}` | counter: transações que chegaram a cada status, inclusive `PENDING_REFERENCE` e as resolvidas pelo worker (replays não contam) | Fase 3 |
| `pending_reference_retries_total{outcome}` | counter: reavaliações do worker (`processed`, `rejected`, `still_pending`, `skipped`) | Fase 5 |
| `wager_transactions_pending_reference` | gauge: transações aguardando referência (atualizado a cada ciclo do worker) | Fase 5 |
| `wager_transaction_processing_seconds{kind}` | histogram (inclui espera pelo lock) | Fase 3 |
| `wallet_lock_conflicts_total` | counter (wallet já travada por outra transação) | Fase 3 |
| `reconciliation_mismatches_total` | counter | Fase 3 |
| `idempotency_duplicates_total{type}` | counter (replay, conflito de chave, external duplicado) | Fase 4 |
| `sqs_messages_consumed_total{outcome}` | counter: mensagens por resultado (`processed`, `rejected`, `pending_reference`, `replay`, `duplicate_delivery`, `retry`, `dead_letter`, `released`) | Fase 6 |
| `idempotency_duplicates_total{type="inbox"}` | counter: redeliveries reconhecidas pela inbox | Fase 6 |
| `sqs_consumer_retries_total` | counter: mensagens devolvidas com backoff | Fase 6 |
| `sqs_dead_lettered_total{reason}` | counter: mensagens enviadas à DLQ pelo consumidor | Fase 6 |
| `outbox_events_published_total{eventType}` | counter | Fase 6 |
| `outbox_publish_failures_total` | counter | Fase 6 |
| `outbox_lag_seconds` | gauge: idade do evento pendente mais antigo | Fase 6 |

**Reconciliação (`POST /wallets/:walletId/reconciliation`).** Uma única consulta SQL lê o saldo armazenado e soma créditos e débitos do ledger (mesmo snapshot, sem falso alarme por commit no meio). Devolve `storedBalance`, `calculatedBalance`, `difference` (= armazenado − calculado), `consistent`, `checkedEntries`. Divergência gera log `error`, incrementa `reconciliation_mismatches_total` e é sinalizada na resposta; **nunca é corrigida**.

## 10. Ambiente de testes

- Testes de integração usam PostgreSQL e MiniStack reais (containers), banco separado `wagering_test` (o helper recusa qualquer banco que não termine em `_test`) e filas com prefixo único por execução.
- **Dados nos testes:** cada teste cria seus próprios registros com ids novos (UUID v7) e nunca depende de tabela vazia — **não há limpeza entre testes e nenhum trigger ou constraint é desligado** (nem `session_replication_role`). Reset completo, quando necessário, é feito pela própria migration (`down` até 0 e `up`), como no teste de migrations.
- Unitários rodam local (Windows) ou no container; integração e processos rodam no container Linux (`docker compose run --rm tests`, com o código montado como volume).
- **Windows não entrega SIGTERM**: medido com `Bun.spawn` + `kill('SIGTERM')` — o handler não executa e o processo morre com código 143. Não existe distro Linux no WSL (só `docker-desktop`), então testes de processo/sinais rodam no container Linux: `docker compose run --rm tests`, onde passam.
- **Indisponibilidade do banco nos testes:** dentro do container de testes não há `docker`, então `test/support/tcp-proxy.ts` (proxy TCP de teste entre app e PostgreSQL) simula o `docker compose pause`: em pausa, descarta todos os bytes. O `docker compose pause postgres` real foi verificado manualmente a partir do host (503 + `Retry-After`, processo continua vivo, reenvio processa uma única vez).
- **Múltiplas instâncias:** `test/concurrency/multi-instance.test.ts` sobe 3 processos `bun run src/main.ts` (portas 3101–3103) com `Bun.spawn`, todos no mesmo PostgreSQL.
- **Mensageria nos testes:** cada arquivo cria filas com prefixo único (`test/support/sqs.ts`). Consumidor e publisher ficam desligados no app de teste e são conduzidos por `pollOnce()`/`publishOnce()`; os cenários de crash, SIGTERM, 3 consumidores e reinício sobem **processos reais** com `test/support/instances.ts`. Arquivos que verificam a fila de eventos marcam como publicados, no banco de teste, os eventos acumulados por outros arquivos (`discardForeignOutboxBacklog`), que não fazem parte do cenário.

## 11. Problemas conhecidos e patches

- **Patch local no kysely 0.29.6 (vazamento de conexão quando o `BEGIN` falha) — aplicado.**
  - **Bug:** em `ControlledTransactionBuilder.execute()` (kysely 0.29.6, usado pelo MikroORM 7.2.5; 0.29.6 também era a versão mais recente publicada), a conexão é obtida do pool e, se `beginTransaction` lança (ex.: `Query read timeout` com o banco sem responder), ela nunca é liberada.
  - **Medição antes do patch:** 1 conexão presa por POST feito com o banco pausado, também depois de o banco voltar; consultas sem transação não vazavam. Impacto: após `DB_POOL_MAX` falhas a instância só respondia 503 até reiniciar, e o `close()` do shutdown esperava para sempre.
  - **Patch** (`patches/kysely@0.29.6.patch`, registrado em `patchedDependencies` do `package.json`; o `Dockerfile` copia `patches/` antes do `bun install`): (1) no `catch` do `beginTransaction`, a conexão é liberada; (2) em `PostgresConnection`, se uma consulta falha por erro **do lado do cliente** (timeout, conexão perdida — erros sem `severity`, que só os erros do servidor têm), a conexão é devolvida ao `pg-pool` com erro, para ser **descartada** em vez de reutilizada. O item (2) evita devolver ao pool uma conexão em estado desconhecido (por exemplo, um `BEGIN` que ainda vai ser executado no servidor quando ele voltar do `pause`, deixando uma transação aberta para a próxima requisição).
  - **Teste:** `test/integration/database-unavailable.test.ts` faz mais falhas de `BEGIN` (6) do que o tamanho do pool (4) com o banco pausado e prova que, quando ele volta, não há conexões presas e a instância responde 200 sem reiniciar; o `close()` do teste fecha normalmente (sem timeout de contorno). Rodado também **sem** o patch, o mesmo teste falha (2 conexões presas e `close()` travado).
  - **Remover o patch** quando o upstream do kysely corrigir o `ControlledTransactionBuilder` (e o MikroORM passar a depender dessa versão).
