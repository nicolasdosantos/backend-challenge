import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InvalidRequestError } from '../application-errors';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { newId } from '../domain/id';
import type { MoneyProps } from '../domain/money';
import { CreateWallet, type WalletView } from './create-wallet';
import { ReconciliationService, type ReconciliationReport } from './reconciliation';
import { WalletQueries, type LedgerPage } from './wallet-queries';

interface CreateWalletBody {
  playerId: string;
  initialBalance: MoneyProps;
}

function parseCreateWalletBody(body: unknown): CreateWalletBody {
  const b = body as Partial<Record<keyof CreateWalletBody, unknown>> | null;
  const balance = b?.initialBalance as Partial<Record<keyof MoneyProps, unknown>> | undefined;
  if (typeof b?.playerId !== 'string' || b.playerId.length === 0) {
    throw new InvalidRequestError('playerId must be a non-empty string');
  }
  if (typeof balance?.amount !== 'string' || typeof balance.currency !== 'string') {
    throw new InvalidRequestError('initialBalance must be { amount: string, currency: string }');
  }
  return { playerId: b.playerId, initialBalance: { amount: balance.amount, currency: balance.currency } };
}

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly reconciliation: ReconciliationService,
    private readonly queries: WalletQueries,
  ) {}

  /** Criação de recurso → 201 (o único 201 da API). */
  @Post()
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WalletView> {
    return this.createWallet.execute({ ...parseCreateWalletBody(body), correlationId: correlationId ?? newId() });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<LedgerPage> {
    return this.queries.getLedgerPage(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationReport> {
    return this.reconciliation.reconcile(walletId);
  }
}
