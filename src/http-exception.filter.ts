import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  DuplicateWalletError,
  IdempotencyKeyConflictError,
  InvalidRequestError,
  NotSupportedYetError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from './application-errors';
import { DomainError } from './domain/errors';
import { isTransientInfrastructureError } from './infrastructure-errors';

/** Corpo de erro único em todos os endpoints. */
export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  failureCode?: string;
}

interface JsonResponse {
  status(code: number): JsonResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export const RETRY_AFTER_SECONDS = '2';

/**
 * Traduz qualquer erro para HTTP com o mesmo formato em todos os endpoints.
 * Rejeição de negócio (422) não passa por aqui: é um resultado gravado, montado no controller.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    const [status, body] = this.map(error);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    if (status >= 500) {
      this.logger.error({
        message: 'request failed',
        code: body.code,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
    response.status(status).json(body);
  }

  private map(error: unknown): [number, ErrorBody] {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    const fail = (status: number, code: string, retryable = false): [number, ErrorBody] => [status, { code, message, retryable }];

    if (error instanceof InvalidRequestError || error instanceof DomainError) return fail(400, 'INVALID_PAYLOAD');
    if (error instanceof WalletNotFoundError) return fail(404, 'WALLET_NOT_FOUND');
    if (error instanceof TransactionNotFoundError) return fail(404, 'TRANSACTION_NOT_FOUND');
    if (error instanceof DuplicateWalletError) return fail(409, 'WALLET_ALREADY_EXISTS');
    if (error instanceof IdempotencyKeyConflictError) return fail(409, 'IDEMPOTENCY_KEY_CONFLICT');
    if (error instanceof DuplicateExternalTransactionError) return fail(409, 'DUPLICATE_EXTERNAL_TRANSACTION');
    if (error instanceof NotSupportedYetError) return fail(501, 'NOT_SUPPORTED_YET');
    if (isTransientInfrastructureError(error)) {
      return [503, { code: 'SERVICE_UNAVAILABLE', message: 'Temporary infrastructure failure, retry later', retryable: true }];
    }
    if (error instanceof HttpException) {
      // Erros do próprio NestJS (rota inexistente, JSON malformado...) no mesmo formato.
      const status = error.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
      return fail(status, code, status >= 500);
    }
    return [500, { code: 'INTERNAL_ERROR', message: 'Unexpected error', retryable: false }];
  }
}
