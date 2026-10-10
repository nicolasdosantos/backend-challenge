/**
 * Verifica se o emulador de SQS suporta o comportamento que o projeto depende.
 * Uso: bun run scripts/check-sqs-emulator.ts
 * Cria filas com nome único por execução e as remove ao final.
 */
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../src/sqs/sqs';

const client = createSqsClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
});
const runId = Date.now().toString(36);
const createdQueues: string[] = [];
const results: { check: string; ok: boolean; detail: string }[] = [];

async function createQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: `check-${runId}-${name}.fifo`, Attributes: { FifoQueue: 'true', ...attributes } }),
  );
  if (!QueueUrl) throw new Error('no queue url');
  createdQueues.push(QueueUrl);
  return QueueUrl;
}

async function queueArn(sqs: SQSClient, url: string): Promise<string> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
  if (!Attributes?.QueueArn) throw new Error('no queue arn');
  return Attributes.QueueArn;
}

async function receive(url: string, visibilityTimeout: number, max = 10): Promise<Message[]> {
  const { Messages } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: max,
      VisibilityTimeout: visibilityTimeout,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }),
  );
  return Messages ?? [];
}

async function send(url: string, body: string, groupId: string, dedupId: string) {
  return client.send(
    new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: dedupId }),
  );
}

function record(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
}

async function checkFifoOrder() {
  const url = await createQueue('order');
  for (let i = 0; i < 10; i++) await send(url, `m${i}`, 'group-a', `order-${i}`);
  const received: string[] = [];
  for (let attempt = 0; attempt < 5 && received.length < 10; attempt++) {
    for (const m of await receive(url, 30)) {
      received.push(m.Body ?? '');
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  const expected = Array.from({ length: 10 }, (_, i) => `m${i}`);
  record('1. FIFO: ordem dentro do MessageGroupId', received.join() === expected.join(), `recebido=[${received.join(',')}]`);

  // Enquanto uma mensagem do grupo está em voo, as seguintes do mesmo grupo ficam bloqueadas.
  const blockUrl = await createQueue('group-block');
  await send(blockUrl, 'b0', 'group-b', 'block-0');
  await send(blockUrl, 'b1', 'group-b', 'block-1');
  const first = await receive(blockUrl, 30, 1);
  const whileInFlight = await receive(blockUrl, 30, 10);
  record(
    '1b. FIFO: grupo bloqueado enquanto mensagem está em voo',
    first[0]?.Body === 'b0' && whileInFlight.length === 0,
    `primeira=${first[0]?.Body}, recebidas em seguida=${whileInFlight.length}`,
  );
}

async function checkDeduplication() {
  const url = await createQueue('dedup');
  const a = await send(url, 'payload', 'g', 'same-dedup-id');
  const b = await send(url, 'payload', 'g', 'same-dedup-id');
  const messages = await receive(url, 30);
  record(
    '2. Deduplicação por MessageDeduplicationId',
    messages.length === 1,
    `envios aceitos=2, mensagens na fila=${messages.length}, mesmo MessageId=${a.MessageId === b.MessageId}`,
  );
}

async function checkVisibilityAndRedelivery() {
  const url = await createQueue('visibility');
  await send(url, 'v', 'g', 'vis-1');

  const [first] = await receive(url, 2);
  const immediately = await receive(url, 2);
  await Bun.sleep(3000);
  const [again] = await receive(url, 30);
  record(
    '5. Reentrega após o visibility timeout',
    !!first && immediately.length === 0 && again?.Body === 'v' && again.Attributes?.ApproximateReceiveCount === '2',
    `invisível logo após receive=${immediately.length === 0}, reentregue=${again?.Body === 'v'}, receiveCount=${again?.Attributes?.ApproximateReceiveCount}`,
  );

  if (!again?.ReceiptHandle) return;
  await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: again.ReceiptHandle, VisibilityTimeout: 0 }));
  const [afterChange] = await receive(url, 30);
  record(
    '4. ChangeMessageVisibility (devolve visibilidade imediatamente)',
    afterChange?.Body === 'v',
    `disponível logo após VisibilityTimeout=0: ${afterChange?.Body === 'v'}`,
  );
}

async function checkRedrive() {
  const dlqUrl = await createQueue('redrive-dlq');
  const dlqArn = await queueArn(client, dlqUrl);
  const url = await createQueue('redrive-main', {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 2 }),
  });
  await send(url, 'poison', 'g', 'redrive-1');

  const receiveCounts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const msgs = await receive(url, 1);
    if (msgs[0]) receiveCounts.push(msgs[0].Attributes?.ApproximateReceiveCount ?? '?');
    await Bun.sleep(1500);
  }
  const inDlq = await receive(dlqUrl, 30);
  const leftInMain = await receive(url, 30);
  record(
    '3. Redrive para DLQ via maxReceiveCount=2',
    inDlq.length === 1 && inDlq[0]?.Body === 'poison' && leftInMain.length === 0,
    `receives na principal=[${receiveCounts.join(',')}], na DLQ=${inDlq.length}, restante na principal=${leftInMain.length}`,
  );
}

try {
  await checkFifoOrder();
  await checkDeduplication();
  await checkVisibilityAndRedelivery();
  await checkRedrive();
} finally {
  for (const url of createdQueues) {
    await client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check} — ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nEmulador aprovado.' : `\n${failed} verificação(ões) falharam.`);
process.exit(failed === 0 ? 0 : 1);
