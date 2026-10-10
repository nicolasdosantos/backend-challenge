import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config';
import { createOrmConfig } from './database/mikro-orm.config';
import { HealthController } from './health/health.controller';
import { HttpExceptionFilter } from './http-exception.filter';
import { Metrics } from './metrics/metrics';
import { MetricsController } from './metrics/metrics.controller';
import { createSqsClient, SQS_CLIENT } from './sqs/sqs';
import { PendingReferenceWorker } from './wagering/pending-reference.worker';
import { ProcessWagerTransaction } from './wagering/process-wager-transaction';
import { TransactionQueries } from './wagering/transaction-queries';
import { WageringController } from './wagering/wagering.controller';
import { CreateWallet } from './wallets/create-wallet';
import { ReconciliationService } from './wallets/reconciliation';
import { WalletQueries } from './wallets/wallet-queries';
import { WalletsController } from './wallets/wallets.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const ormConfig = createOrmConfig(config.databaseUrl, {
      poolMax: config.dbPoolMax,
      connectTimeoutMs: config.dbConnectTimeoutMs,
      queryTimeoutMs: config.dbQueryTimeoutMs,
    });
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(ormConfig)],
      controllers: [HealthController, MetricsController, WalletsController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.sqs) },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        Metrics,
        ProcessWagerTransaction,
        PendingReferenceWorker,
        CreateWallet,
        ReconciliationService,
        WalletQueries,
        TransactionQueries,
      ],
    };
  }
}
