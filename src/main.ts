import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

const config = loadConfig();
const app = await NestFactory.create(AppModule.forRoot(config), {
  logger: new ConsoleLogger({ json: true }),
});
await app.listen(config.port);

// Shutdown gracioso: app.close() executa os hooks de destroy/shutdown dos módulos (consumidor drena,
// workers param, pool do banco fecha) e só então o processo sai, com 0 se tudo fechou bem.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    const logger = new Logger('Shutdown');
    logger.log({ message: 'shutdown requested', signal });
    try {
      await app.close();
      logger.log({ message: 'shutdown complete' });
      process.exit(0);
    } catch (error) {
      logger.error({ message: 'shutdown failed', reason: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  });
}
