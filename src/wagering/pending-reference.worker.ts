import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { Metrics } from '../metrics/metrics';
import { ProcessWagerTransaction, type PendingReferenceOutcome } from './process-wager-transaction';

const BATCH_SIZE = 50;

interface DueTransaction {
  id: string;
  wallet_id: string;
}

/**
 * Loop agendado (setTimeout encadeado, sem dependência extra) que reavalia transações em
 * PENDING_REFERENCE cujo `next_reference_attempt_at` já passou. A seleção é só uma lista de
 * candidatos, sem lock: a decisão acontece em `retryPendingReference`, que trava a wallet e relê
 * a transação. Por isso vários workers (ou instâncias) podem rodar ao mesmo tempo com efeito único.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: Timer | undefined;
  private currentRun: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.pendingReference.workerEnabled) {
      this.scheduleNext();
    }
  }

  /** Shutdown: não agenda mais ciclos e espera o ciclo em andamento terminar. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.currentRun;
  }

  /** Um ciclo: reavalia as transações vencidas. Público para os testes conduzirem o tempo. */
  async processDue(now = new Date()): Promise<PendingReferenceOutcome[]> {
    const due = await this.orm.em.getConnection().execute<DueTransaction[]>(
      `select id, wallet_id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
        order by next_reference_attempt_at
        limit ?`,
      [now, BATCH_SIZE],
    );
    const outcomes: PendingReferenceOutcome[] = [];
    for (const row of due) {
      if (this.stopped) break;
      outcomes.push(await this.processWagerTransaction.retryPendingReference(row.id, row.wallet_id));
    }
    await this.updatePendingGauge();
    return outcomes;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.currentRun = this.runOnce().finally(() => this.scheduleNext());
    }, this.config.pendingReference.pollIntervalMs);
  }

  private async runOnce(): Promise<void> {
    try {
      await this.processDue();
    } catch (error) {
      // Falha passageira (ex.: banco fora do ar): o próximo ciclo tenta de novo.
      this.logger.warn({
        message: 'pending reference worker cycle failed',
        reason: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
      });
    }
  }

  private async updatePendingGauge(): Promise<void> {
    const [row] = await this.orm.em
      .getConnection()
      .execute<{ count: number }[]>(`select count(*)::int as count from wager_transactions where status = 'PENDING_REFERENCE'`);
    this.metrics.pendingReferences.set(row?.count ?? 0);
  }
}
