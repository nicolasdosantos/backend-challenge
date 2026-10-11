/**
 * Envia uma mensagem WagerTransactionRequested (formato do enunciado §10) para a fila de entrada.
 * Uso: bun run scripts/send-wager-message.ts <walletId> <playerId> [amount=10.00] [kind=BET]
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient, resolveQueueUrls } from '../src/sqs/sqs';

const [walletId, playerId, amount = '10.00', kind = 'BET'] = process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('Uso: bun run scripts/send-wager-message.ts <walletId> <playerId> [amount=10.00] [kind=BET]');
  process.exit(1);
}

const sqs = createSqsClient({ endpoint: process.env.SQS_ENDPOINT, region: process.env.AWS_REGION ?? 'us-east-1' });
const queues = await resolveQueueUrls(sqs, process.env.SQS_QUEUE_PREFIX ?? '');

const externalTransactionId = `tx-${crypto.randomUUID()}`;
const messageId = `msg-${crypto.randomUUID()}`;
const message = {
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: `round-${crypto.randomUUID()}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
  },
};

await sqs.send(
  new SendMessageCommand({
    QueueUrl: queues.wagerTransactions,
    MessageBody: JSON.stringify(message),
    MessageGroupId: walletId,
    MessageDeduplicationId: messageId,
  }),
);
console.log(JSON.stringify({ sent: true, messageId, externalTransactionId }));
