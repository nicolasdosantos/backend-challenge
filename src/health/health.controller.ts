// Health checks: /health/live (o processo está de pé) e /health/ready (PostgreSQL e SQS respondendo).

import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { QUEUE_NAMES, SQS_CLIENT } from '../sqs/sqs';

type CheckStatus = 'up' | 'down';

// Prazo de cada verificação: um banco ou SQS travado vira "down" em vez de deixar o readiness pendurado.
const CHECK_TIMEOUT_MS = 2000;

/** Health checks ficam fora de qualquer autenticação (enunciado §2 e §9). */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: { status(code: number): void }) {
    const [postgres, sqs] = await Promise.all([
      // checkConnection() do MikroORM 7 não faz round-trip enquanto o pool não abriu conexão; select 1 faz.
      this.runCheck('postgres', () => this.orm.em.getConnection().execute('select 1')),
      this.runCheck('sqs', () =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.queuePrefix + QUEUE_NAMES.wagerTransactions })),
      ),
    ]);

    const body = { status: postgres === 'up' && sqs === 'up' ? 'ok' : 'error', checks: { postgres, sqs } };
    if (body.status !== 'ok') {
      response.status(503); // corpo próprio do health, fora do formato de erro da API
    }
    return body;
  }

  private async runCheck(name: string, check: () => Promise<unknown>): Promise<CheckStatus> {
    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([check(), timeout]);
      return 'up';
    } catch (error) {
      // Só o nome e a mensagem do erro: nada de connection string ou credenciais.
      this.logger.warn({
        message: 'readiness check failed',
        check: name,
        reason: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
      });
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
