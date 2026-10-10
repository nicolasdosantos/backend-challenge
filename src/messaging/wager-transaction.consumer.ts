import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  IdempotencyKeyConflictError,
  InboxPayloadConflictError,
  InvalidRequestError,
  WalletNotFoundError,
} from '../application-errors';
import { APP_CONFIG, type AppConfig } from '../config';
import { DomainError } from '../domain/errors';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { isTransientInfrastructureError } from '../infrastructure-errors';
import { Metrics } from '../metrics/metrics';
import { resolveQueueUrls, SQS_CLIENT, type QueueUrls } from '../sqs/sqs';
import { DUPLICATE_DELIVERY, ProcessWagerTransaction } from '../wagering/process-wager-transaction';
import { InvalidMessageError, parseWagerMessage, type DeadLetterReason } from './wager-message';

export const CONSUMER_NAME = 'wager-transactions-consumer';

export type ConsumeOutcome =
  | 'processed'
  | 'rejected'
  | 'pending_reference'
  | 'replay'
  | 'duplicate_delivery'
  | 'retry'
  | 'dead_letter'
  | 'released';

/** Erros que nunca vão se resolver reenviando a mesma mensagem: vão direto à DLQ. */
function deadLetterReason(error: unknown): DeadLetterReason | undefined {
  if (error instanceof InvalidMessageError) return error.reason;
  if (error instanceof WalletNotFoundError) return 'WALLET_NOT_FOUND';
  if (error instanceof IdempotencyKeyConflictError) return 'IDEMPOTENCY_KEY_CONFLICT';
  if (error instanceof DuplicateExternalTransactionError) return 'DUPLICATE_EXTERNAL_TRANSACTION';
  if (error instanceof InboxPayloadConflictError) return 'INBOX_PAYLOAD_CONFLICT';
  if (error instanceof InvalidRequestError || error instanceof DomainError) return 'INVALID_PAYLOAD';
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

/**
 * Consumidor da fila wager-transactions.fifo. Para cada mensagem: valida, chama o MESMO caso de uso
 * da API (com a inbox na mesma transação SQL) e só depois do commit faz o ack (DeleteMessage).
 * - negócio (REJECTED, PENDING_REFERENCE, replay, redelivery): terminal → ack;
 * - transitório (banco/SQS indisponível, timeout, deadlock): sem ack, ChangeMessageVisibility com backoff;
 *   a redrive policy (maxReceiveCount) leva à DLQ quem esgotar as tentativas;
 * - permanente (mensagem/payload inválido, wallet inexistente, conflitos): envia à DLQ e só então apaga.
 */
@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly abort = new AbortController();
  private queues: QueueUrls | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly metrics: Metrics,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.consumer.enabled) {
      this.loop = this.run();
    }
  }

  /**
   * Shutdown (SIGTERM): para de buscar mensagens (aborta o long polling), devolve a visibilidade das
   * recebidas e ainda não iniciadas e espera a mensagem em andamento até `shutdownTimeoutMs`.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (!this.loop) return;
    const finished = await Promise.race([
      this.loop.then(() => true),
      Bun.sleep(this.config.consumer.shutdownTimeoutMs).then(() => false),
    ]);
    if (!finished) {
      // Não há como interromper a transação no meio; se ela não commitar, a mensagem volta após o
      // visibility timeout e a inbox/idempotência impedem efeito duplicado.
      this.logger.warn({ message: 'consumer shutdown timed out with a message still in progress' });
      return;
    }
    this.logger.log({ message: 'consumer stopped' });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) break;
        this.logger.warn({ message: 'consumer poll failed', reason: describe(error) });
        await Bun.sleep(1000);
      }
    }
  }

  /** Um ciclo de long polling + processamento sequencial do lote. Público para os testes. */
  async pollOnce(): Promise<ConsumeOutcome[]> {
    const queues = await this.queueUrls();
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.wagerTransactions,
        MaxNumberOfMessages: this.config.consumer.batchSize,
        WaitTimeSeconds: this.config.consumer.waitTimeSeconds,
        VisibilityTimeout: this.config.consumer.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.abort.signal },
    );

    const outcomes: ConsumeOutcome[] = [];
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        const notStarted = messages.slice(index);
        await this.release(queues, notStarted);
        outcomes.push(...notStarted.map((): ConsumeOutcome => 'released'));
        break;
      }
      outcomes.push(await this.handle(queues, message));
    }
    return outcomes;
  }

  private async handle(queues: QueueUrls, message: Message): Promise<ConsumeOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let outcome: ConsumeOutcome;
    let messageId: string | undefined;
    try {
      const parsed = parseWagerMessage(message.Body ?? '');
      messageId = parsed.messageId;
      const result = await this.processWagerTransaction.executeFromMessage(parsed.command, {
        consumerName: CONSUMER_NAME,
        messageId: parsed.messageId,
      });
      // A transação SQL já foi commitada aqui.
      this.crashIfFaultInjected(parsed.messageId);
      outcome = result === DUPLICATE_DELIVERY ? 'duplicate_delivery' : result.idempotentReplay ? 'replay' : this.toOutcome(result.status);
    } catch (error) {
      const reason = deadLetterReason(error);
      outcome = reason
        ? await this.deadLetter(queues, message, messageId, reason, error)
        : await this.retryLater(queues, message, messageId, receiveCount, error);
      this.metrics.messagesConsumed.inc({ outcome });
      return outcome;
    }

    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queues.wagerTransactions, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      // Commit feito, ack falhou: a mensagem volta depois do visibility timeout e a inbox a reconhece.
      this.logger.warn({ message: 'ack failed after commit', messageId, reason: describe(error) });
    }
    this.metrics.messagesConsumed.inc({ outcome });
    return outcome;
  }

  private toOutcome(status: WagerTransactionStatus): ConsumeOutcome {
    if (status === WagerTransactionStatus.Rejected) return 'rejected';
    if (status === WagerTransactionStatus.PendingReference) return 'pending_reference';
    return 'processed';
  }

  /** Backoff exponencial pelo ApproximateReceiveCount: base, 2×base, 4×base... até o máximo. */
  private retryDelaySeconds(receiveCount: number): number {
    const { retryBaseDelaySeconds, retryMaxDelaySeconds } = this.config.consumer;
    return Math.min(retryBaseDelaySeconds * 2 ** Math.max(receiveCount - 1, 0), retryMaxDelaySeconds);
  }

  private async retryLater(
    queues: QueueUrls,
    message: Message,
    messageId: string | undefined,
    receiveCount: number,
    error: unknown,
  ): Promise<ConsumeOutcome> {
    const delay = this.retryDelaySeconds(receiveCount);
    this.metrics.consumerRetries.inc();
    this.logger.warn({
      message: isTransientInfrastructureError(error) ? 'transient failure, message will be retried' : 'unexpected failure, message will be retried',
      messageId,
      receiveCount,
      retryInSeconds: delay,
      reason: describe(error),
    });
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.wagerTransactions,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delay,
        }),
      );
    } catch (changeError) {
      // Sem conseguir mudar a visibilidade, a mensagem volta no visibility timeout original.
      this.logger.warn({ message: 'could not change message visibility', messageId, reason: describe(changeError) });
    }
    return 'retry';
  }

  /** Envia à DLQ e SÓ ENTÃO apaga da fila principal. Se o envio falhar, trata como transitório. */
  private async deadLetter(
    queues: QueueUrls,
    message: Message,
    messageId: string | undefined,
    reason: DeadLetterReason,
    error: unknown,
  ): Promise<ConsumeOutcome> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.wagerTransactionsDlq,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            reason: { DataType: 'String', StringValue: reason },
            error: { DataType: 'String', StringValue: describe(error).slice(0, 500) },
          },
        }),
      );
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queues.wagerTransactions, ReceiptHandle: message.ReceiptHandle }));
    } catch (sendError) {
      return this.retryLater(queues, message, messageId, Number(message.Attributes?.ApproximateReceiveCount ?? '1'), sendError);
    }
    this.metrics.deadLettered.inc({ reason });
    this.logger.error({ message: 'message sent to dead-letter queue', messageId, reason, error: describe(error) });
    return 'dead_letter';
  }

  /** Mensagens recebidas e não iniciadas voltam a ficar visíveis na hora (visibility 0). */
  private async release(queues: QueueUrls, messages: Message[]): Promise<void> {
    this.logger.log({ message: 'shutting down: releasing messages not started', count: messages.length });
    for (const message of messages) {
      await this.sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queues.wagerTransactions,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        )
        .catch((error: unknown) => this.logger.warn({ message: 'could not release message', reason: describe(error) }));
    }
  }

  /**
   * RECURSO DE TESTE (FAULT_CRASH_AFTER_COMMIT=1): simula o processo morrendo depois do commit e
   * antes do ack, para provar que a reentrega não gera efeito duplicado. Inerte por padrão.
   */
  private crashIfFaultInjected(messageId: string): void {
    if (this.config.consumer.crashAfterCommit) {
      this.logger.error({ message: 'FAULT_CRASH_AFTER_COMMIT: exiting after commit and before ack', messageId });
      process.exit(1);
    }
  }

  private async queueUrls(): Promise<QueueUrls> {
    this.queues ??= await resolveQueueUrls(this.sqs, this.config.sqs.queuePrefix);
    return this.queues;
  }
}
