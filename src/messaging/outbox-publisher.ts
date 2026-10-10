import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { OutboxMessage } from '../domain/outbox-message';
import { Metrics } from '../metrics/metrics';
import { resolveQueueUrls, SQS_CLIENT, type QueueUrls } from '../sqs/sqs';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string | Date;
  attempts: number;
  next_attempt_at: string | Date | null;
}

export interface PublishResult {
  published: number;
  failed: number;
}

/**
 * Publica os eventos da outbox na fila wallet-events.fifo. Cada ciclo é UMA transação SQL:
 *   SELECT ... FOR UPDATE SKIP LOCKED (lote de pendentes vencidos) → SendMessage → marca published_at → COMMIT.
 * - Só enxerga eventos já commitados pela transação de negócio: nada é publicado antes do commit.
 * - Vários publishers (instâncias) pegam lotes disjuntos graças ao SKIP LOCKED.
 * - Se o processo morre no meio, a transação some, o lock cai e outro publisher reenvia: entrega
 *   at-least-once. MessageDeduplicationId = eventId reduz duplicatas no broker; o consumidor deve
 *   deduplicar pelo eventId.
 * - Falha de envio: o evento é reagendado (attempts+1, backoff) e nunca é marcado como publicado.
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private queues: QueueUrls | undefined;
  private timer: Timer | undefined;
  private currentRun: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.outbox.publisherEnabled) {
      this.scheduleNext();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.currentRun;
  }

  /** Um ciclo de publicação. Público para os testes. */
  async publishOnce(now = new Date()): Promise<PublishResult> {
    const queues = await this.queueUrls();
    const result = await this.orm.em.fork().transactional(async (em) => {
      const rows = await em.getConnection().execute<OutboxRow[]>(
        `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
           from outbox_messages
          where published_at is null and (next_attempt_at is null or next_attempt_at <= ?)
          order by occurred_at, id
          limit ?
          for update skip locked`,
        [now, this.config.outbox.batchSize],
        'all',
        em.getTransactionContext(),
      );

      const counts: PublishResult = { published: 0, failed: 0 };
      for (const row of rows) {
        const message = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
        });
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: queues.walletEvents,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }),
          );
          message.markPublished(new Date());
          counts.published += 1;
          this.metrics.eventsPublished.inc({ eventType: message.eventType });
        } catch (error) {
          message.scheduleRetry(new Date());
          counts.failed += 1;
          this.metrics.publishFailures.inc();
          this.logger.warn({
            message: 'outbox publish failed, rescheduled',
            eventId: message.id,
            aggregateId: message.aggregateId,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            reason: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
          });
        }
        await this.afterSend(message.id);
        await this.saveState(em, message);
      }
      return counts;
    });
    await this.updateLagGauge();
    return result;
  }

  private async saveState(em: EntityManager, message: OutboxMessage): Promise<void> {
    await em
      .getConnection()
      .execute(
        `update outbox_messages set attempts = ?, next_attempt_at = ?, published_at = ? where id = ?`,
        [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
        'run',
        em.getTransactionContext(),
      );
  }

  /**
   * Chamado depois do envio e antes de gravar `published_at`. Não faz nada em produção; os testes
   * sobrescrevem para simular o processo morrendo nesse intervalo (a transação desfaz tudo).
   */
  protected async afterSend(_eventId: string): Promise<void> {}

  private async updateLagGauge(): Promise<void> {
    const [row] = await this.orm.em
      .getConnection()
      .execute<{ lag: string | null }[]>(
        `select extract(epoch from (now() - min(occurred_at)))::text as lag from outbox_messages where published_at is null`,
      );
    this.metrics.outboxLagSeconds.set(row?.lag ? Number(row.lag) : 0);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.currentRun = this.runOnce().finally(() => this.scheduleNext());
    }, this.config.outbox.pollIntervalMs);
  }

  private async runOnce(): Promise<void> {
    try {
      await this.publishOnce();
    } catch (error) {
      this.logger.warn({
        message: 'outbox publisher cycle failed',
        reason: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
      });
    }
  }

  private async queueUrls(): Promise<QueueUrls> {
    this.queues ??= await resolveQueueUrls(this.sqs, this.config.sqs.queuePrefix);
    return this.queues;
  }
}
