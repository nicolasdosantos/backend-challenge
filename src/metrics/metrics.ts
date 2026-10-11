import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Métricas Prometheus. Registry próprio (não o global do prom-client) para que vários apps
 * no mesmo processo — caso dos testes — não colidam ao registrar os mesmos nomes.
 */
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações que chegaram a cada status (inclui PENDING_REFERENCE), por kind',
    labelNames: ['kind', 'status'] as const,
    registers: [this.registry],
  });

  readonly processingSeconds = new Histogram({
    name: 'wager_transaction_processing_seconds',
    help: 'Latência do processamento de uma transação (inclui espera pelo lock da wallet)',
    labelNames: ['kind'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Operações que encontraram a wallet já travada por outra transação e precisaram esperar',
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'idempotency_duplicates_total',
    help: 'Duplicatas detectadas: replay, conflito de Idempotency-Key ou externalTransactionId repetido',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly pendingReferenceRetries = new Counter({
    name: 'pending_reference_retries_total',
    help: 'Reavaliações de transações em PENDING_REFERENCE, por resultado',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly pendingReferences = new Gauge({
    name: 'wager_transactions_pending_reference',
    help: 'Transações aguardando referência (lido do banco no scrape; -1 se indisponível)',
    registers: [this.registry],
  });

  readonly messagesConsumed = new Counter({
    name: 'sqs_messages_consumed_total',
    help: 'Mensagens da fila wager-transactions por resultado (processed, rejected, pending_reference, replay, duplicate_delivery, retry, dead_letter, released)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly consumerRetries = new Counter({
    name: 'sqs_consumer_retries_total',
    help: 'Mensagens devolvidas à fila com backoff por erro transitório',
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'Mensagens enviadas explicitamente à DLQ, por motivo',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly deadLetterQueueDepth = new Gauge({
    name: 'sqs_dead_letter_queue_messages',
    help: 'Mensagens na DLQ (inclui as movidas pela redrive policy), lido do SQS no momento do scrape; -1 se indisponível',
    registers: [this.registry],
  });

  readonly eventsPublished = new Counter({
    name: 'outbox_events_published_total',
    help: 'Eventos da outbox publicados na fila wallet-events',
    labelNames: ['eventType'] as const,
    registers: [this.registry],
  });

  readonly publishFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Tentativas de publicação da outbox que falharam (evento reagendado com backoff)',
    registers: [this.registry],
  });

  readonly outboxLagSeconds = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade em segundos do evento não publicado mais antigo (lido do banco no scrape; 0 se não há pendentes, -1 se indisponível)',
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Reconciliações em que o saldo armazenado diverge do saldo reconstruído pelo ledger',
    registers: [this.registry],
  });
}
