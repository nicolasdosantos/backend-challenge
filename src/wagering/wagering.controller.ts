// Endpoints HTTP de transações: submissão (POST /wagering/transactions) e consultas por id interno ou do provedor.

import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { InvalidRequestError } from '../application-errors';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { newId } from '../domain/id';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { ErrorBody } from '../http-exception.filter';
import { parseWagerPayload } from './wager-payload';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
  type WagerTransactionResult,
} from './process-wager-transaction';
import { TransactionQueries, type WagerTransactionView } from './transaction-queries';

/** Valida o corpo e monta o comando. A chave vem SEMPRE do header (fonte da verdade). */
export function parseSubmitRequest(
  body: unknown,
  idempotencyKey: string | undefined,
  correlationId: string | undefined,
): ProcessWagerTransactionCommand {
  if (!idempotencyKey) {
    throw new InvalidRequestError('Idempotency-Key header is required');
  }
  // O corpo pode repetir a chave, mas se repetir tem que ser igual à do header.
  const bodyKey = (body as { idempotencyKey?: unknown } | null)?.idempotencyKey;
  if (bodyKey !== undefined && bodyKey !== idempotencyKey) {
    throw new InvalidRequestError('Body idempotencyKey differs from the Idempotency-Key header');
  }
  // Sem X-Correlation-ID, um id novo é criado para rastrear a requisição nos logs e nos eventos.
  return { ...parseWagerPayload(body), idempotencyKey, correlationId: correlationId ?? newId() };
}

/** Rejeição de negócio: corpo de erro padrão + o resultado gravado (para o replay ser idêntico). */
type RejectionBody = ErrorBody & WagerTransactionResult;

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly queries: TransactionQueries,
  ) {}

  /**
   * 200 PROCESSED (original ou replay; `idempotentReplay` diferencia), 202 PENDING_REFERENCE,
   * 422 REJECTED. Erros (400/404/409/501/503) saem pelo HttpExceptionFilter.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): void },
  ): Promise<WagerTransactionResult | RejectionBody> {
    const result = await this.processWagerTransaction.execute(parseSubmitRequest(body, idempotencyKey, correlationId));

    if (result.status === WagerTransactionStatus.Rejected) {
      response.status(422);
      return {
        code: 'BUSINESS_RULE_REJECTED',
        message: `Transaction rejected: ${result.failureCode}`,
        retryable: false,
        ...result,
      };
    }
    response.status(result.status === WagerTransactionStatus.PendingReference ? 202 : 200);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string): Promise<WagerTransactionView> {
    return this.queries.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.queries.byExternalId(providerId, externalTransactionId);
  }
}
