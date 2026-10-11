import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { QUEUE_NAMES, SQS_CLIENT } from '../sqs/sqs';
import { Metrics } from './metrics';

const DLQ_CHECK_TIMEOUT_MS = 1000;

interface BacklogRow {
  outbox_lag: string | null;
  pending_references: number;
}

/**
 * Os gauges de estado (outbox lag, pendências, profundidade da DLQ) são lidos no momento do scrape,
 * da fonte da verdade (PostgreSQL e SQS): o valor é atual e não depende de esta instância rodar
 * o publicador ou o worker. Se a fonte estiver fora, o gauge vira -1 e o scrape não falha.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: Metrics,
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    await Promise.all([this.updateBacklogGauges(), this.updateDeadLetterQueueDepth()]);
    return this.metrics.registry.metrics();
  }

  private async updateBacklogGauges(): Promise<void> {
    try {
      const [row] = await this.orm.em.getConnection().execute<BacklogRow[]>(
        `select
           (select extract(epoch from (now() - min(occurred_at)))::text from outbox_messages where published_at is null) as outbox_lag,
           (select count(*)::int from wager_transactions where status = 'PENDING_REFERENCE') as pending_references`,
      );
      this.metrics.outboxLagSeconds.set(row?.outbox_lag ? Number(row.outbox_lag) : 0);
      this.metrics.pendingReferences.set(row?.pending_references ?? 0);
    } catch {
      this.metrics.outboxLagSeconds.set(-1);
      this.metrics.pendingReferences.set(-1);
    }
  }

  /** Profundidade da DLQ direto do SQS: cobre também o que a redrive policy moveu sem passar pelo código. */
  private async updateDeadLetterQueueDepth(): Promise<void> {
    try {
      const abortSignal = AbortSignal.timeout(DLQ_CHECK_TIMEOUT_MS);
      const { QueueUrl } = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: this.config.sqs.queuePrefix + QUEUE_NAMES.wagerTransactionsDlq }),
        { abortSignal },
      );
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
        { abortSignal },
      );
      this.metrics.deadLetterQueueDepth.set(Number(Attributes?.ApproximateNumberOfMessages ?? 0));
    } catch {
      this.metrics.deadLetterQueueDepth.set(-1); // SQS indisponível: o scrape não falha por isso
    }
  }
}
