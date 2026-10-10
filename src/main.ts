import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

const config = loadConfig();
const app = await NestFactory.create(AppModule.forRoot(config), {
  logger: new ConsoleLogger({ json: true }),
});
app.enableShutdownHooks();
await app.listen(config.port);
