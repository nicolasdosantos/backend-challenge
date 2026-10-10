import { CurrencyMismatchError, DomainError, InsufficientFundsError } from './errors';
import { newId } from './id';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifica a transação e o instante de uma movimentação. */
export interface MovementContext {
  transactionId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Nasce com o saldo inicial e version 1. O lançamento de abertura vem de openingEntry(). */
  static open(props: { playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (!props.playerId) {
      throw new DomainError('playerId is required');
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainError('Initial balance cannot be negative');
    }
    return new Wallet(
      newId(),
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Lançamento CREDIT de 0 até o saldo inicial, ligado à transação interna OPENING.
   * Não altera saldo nem version: a abertura já nasce com o saldo (version 1).
   */
  openingEntry(context: MovementContext): WalletLedgerEntry {
    if (this._version !== 1) {
      throw new DomainError('Opening entry is only valid for a newly opened wallet');
    }
    return WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: context.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      at: context.at,
    });
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, context: MovementContext): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(`Balance ${this._balance} is not enough to debit ${money}`);
    }
    return this.apply(LedgerDirection.Debit, money, context);
  }

  credit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, context);
  }

  /** Saldo e lançamento mudam juntos: não existe caminho que altere um sem o outro. */
  private apply(direction: LedgerDirection, money: Money, context: MovementContext): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: context.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      at: context.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = context.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet currency is ${this.currency}, got ${money.currency}`);
    }
  }
}
