/** Cria as filas FIFO e a redrive policy. Idempotente. Uso: bun run sqs:create-queues */
import { createSqsClient, ensureQueues } from '../src/sqs/sqs';

const client = createSqsClient({
  endpoint: process.env.SQS_ENDPOINT,
  region: process.env.AWS_REGION ?? 'us-east-1',
});
const urls = await ensureQueues(client, process.env.SQS_QUEUE_PREFIX ?? '');
console.log(JSON.stringify({ message: 'queues ready', ...urls }));
