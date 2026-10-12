// Reconciliação de uma wallet: compara o saldo gravado com o saldo reconstruído a partir do ledger.

import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { WalletNotFoundError } from '../application-errors';
import { Money, type MoneyProps } from '../domain/money';
import { isUuid } from '../domain/id';
import { Metrics } from '../metrics/metrics';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

interface ReconciliationRow {
  balance: string;
  currency: string;
  credits: string;
  debits: string;
  entries: number;
}


@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
  ) {}

  /** Recalcula o saldo pelo ledger e compara com o armazenado. Divergência é reportada, NUNCA corrigida. */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    if (!isUuid(walletId)) {
      throw new WalletNotFoundError(walletId);
    }
    // Uma única consulta: saldo e somatório vêm do mesmo snapshot, sem falso alarme por commit no meio.
    const [row] = await this.orm.em.getConnection().execute<ReconciliationRow[]>(
      `select w.balance::text as balance,
              w.currency,
              coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0)::numeric(20,2)::text as credits,
              coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0)::numeric(20,2)::text as debits,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) {
      throw new WalletNotFoundError(walletId);
    }

    const stored = Money.from({ amount: row.balance, currency: row.currency });
    const calculated = Money.from({ amount: row.credits, currency: row.currency }).subtract(
      Money.from({ amount: row.debits, currency: row.currency }),
    );
    const difference = stored.subtract(calculated);
    const report: ReconciliationReport = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: row.entries,
    };

    if (!report.consistent) {
      this.metrics.reconciliationMismatches.inc();
      this.logger.error({
        message: 'wallet balance diverges from ledger',
        walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
