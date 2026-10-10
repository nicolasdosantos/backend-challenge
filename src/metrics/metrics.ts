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
    help: 'Transações aguardando referência (atualizado a cada ciclo do worker)',
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Reconciliações em que o saldo armazenado diverge do saldo reconstruído pelo ledger',
    registers: [this.registry],
  });
}
