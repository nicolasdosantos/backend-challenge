import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const QUEUE_NAMES = {
  wagerTransactions: 'wager-transactions.fifo',
  wagerTransactionsDlq: 'wager-transactions-dlq.fifo',
  walletEvents: 'wallet-events.fifo',
} as const;

/** Receives antes de a mensagem ir para a DLQ via redrive policy. */
export const MAX_RECEIVE_COUNT = 5;

export interface SqsConnectionOptions {
  endpoint: string | undefined;
  region: string;
}

export function createSqsClient(options: SqsConnectionOptions): SQSClient {
  return new SQSClient({
    endpoint: options.endpoint,
    region: options.region,
    // Credenciais fictícias aceitas pelo emulador local; em AWS real viriam da cadeia padrão do SDK.
    credentials: options.endpoint
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        }
      : undefined,
  });
}

export interface QueueUrls {
  wagerTransactions: string;
  wagerTransactionsDlq: string;
  walletEvents: string;
}

async function createFifoQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string> = {},
): Promise<string> {
  const result = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ...attributes },
    }),
  );
  if (!result.QueueUrl) {
    throw new Error(`CreateQueue returned no URL for ${name}`);
  }
  return result.QueueUrl;
}

/** Cria (ou reaproveita) as três filas FIFO e liga a fila principal à DLQ. */
export async function ensureQueues(
  client: SQSClient,
  prefix = '',
  maxReceiveCount = MAX_RECEIVE_COUNT,
): Promise<QueueUrls> {
  const wagerTransactionsDlq = await createFifoQueue(client, prefix + QUEUE_NAMES.wagerTransactionsDlq);
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: wagerTransactionsDlq, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) {
    throw new Error('DLQ has no QueueArn');
  }

  const wagerTransactions = await createFifoQueue(client, prefix + QUEUE_NAMES.wagerTransactions, {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount }),
  });
  const walletEvents = await createFifoQueue(client, prefix + QUEUE_NAMES.walletEvents);

  return { wagerTransactions, wagerTransactionsDlq, walletEvents };
}

/** Resolve as URLs das filas já existentes (criadas pelo sqs-init ou por `ensureQueues`). */
export async function resolveQueueUrls(client: SQSClient, prefix = ''): Promise<QueueUrls> {
  const url = async (name: string) => {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: prefix + name }));
    if (!QueueUrl) throw new Error(`Queue ${prefix + name} not found`);
    return QueueUrl;
  };
  return {
    wagerTransactions: await url(QUEUE_NAMES.wagerTransactions),
    wagerTransactionsDlq: await url(QUEUE_NAMES.wagerTransactionsDlq),
    walletEvents: await url(QUEUE_NAMES.walletEvents),
  };
}
