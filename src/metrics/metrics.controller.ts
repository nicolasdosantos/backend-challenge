import { Controller, Get, Header } from '@nestjs/common';
import { Metrics } from './metrics';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
