import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { QUEUE_NAMES, SQS_CLIENT } from '../sqs/sqs';
import { Metrics } from './metrics';

const DLQ_CHECK_TIMEOUT_MS = 1000;

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: Metrics,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    await this.updateDeadLetterQueueDepth();
    return this.metrics.registry.metrics();
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
