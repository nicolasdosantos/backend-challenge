import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { newId } from '../../src/domain/id';
import { createSqsClient, ensureQueues, type QueueUrls } from '../../src/sqs/sqs';
import type { ProcessWagerTransactionCommand } from '../../src/wagering/process-wager-transaction';
import { testSqsOptions, uniqueQueuePrefix } from './test-env';

export interface TestQueues {
  sqs: SQSClient;
  prefix: string;
  urls: QueueUrls;
  remove(): Promise<void>;
}

/** Filas com prefixo único por arquivo de teste: nada interfere entre execuções. */
export async function createTestQueues(maxReceiveCount?: number): Promise<TestQueues> {
  const sqs = createSqsClient(testSqsOptions());
  const prefix = uniqueQueuePrefix();
  const urls = await ensureQueues(sqs, prefix, maxReceiveCount);
  return {
    sqs,
    prefix,
    urls,
    remove: async () => {
      for (const url of Object.values(urls)) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
      }
    },
  };
}

/** Envelope do enunciado (§10) para um comando. */
export function wagerMessageBody(command: ProcessWagerTransactionCommand, messageId = `msg-${newId()}`): { messageId: string; body: string } {
  const { correlationId: _c, causationId: _x, ...data } = command;
  return {
    messageId,
    body: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
  };
}

/**
 * Envia uma mensagem para a fila FIFO. `groupId` padrão = walletId (como um provedor faria);
 * testes de paralelismo usam grupos distintos. `deduplicationId` padrão = messageId.
 */
export async function sendRaw(
  q: TestQueues,
  body: string,
  options: { groupId: string; deduplicationId?: string },
): Promise<void> {
  await q.sqs.send(
    new SendMessageCommand({
      QueueUrl: q.urls.wagerTransactions,
      MessageBody: body,
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId ?? newId(),
    }),
  );
}

export async function sendWagerMessage(
  q: TestQueues,
  command: ProcessWagerTransactionCommand,
  options: { messageId?: string; groupId?: string; deduplicationId?: string } = {},
): Promise<string> {
  const { messageId, body } = wagerMessageBody(command, options.messageId);
  await sendRaw(q, body, { groupId: options.groupId ?? command.walletId, deduplicationId: options.deduplicationId ?? messageId });
  return messageId;
}

/** Mensagens visíveis + em voo na fila. */
export async function queueDepth(q: TestQueues, url: string): Promise<number> {
  const { Attributes } = await q.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

/** Lê (e apaga) tudo o que estiver visível numa fila. */
export async function drain(q: TestQueues, url: string, waitSeconds = 1): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const { Messages = [] } = await q.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    if (Messages.length === 0) return all;
    for (const m of Messages) {
      all.push(m);
      await q.sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
    }
  }
}

export async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
