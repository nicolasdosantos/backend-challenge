// Lançamento do ledger: o registro de uma movimentação de saldo. Não muda depois de criado, nem no
// código (sem setters, objeto congelado) nem no banco (trigger que recusa UPDATE/DELETE/TRUNCATE).

import { InvalidLedgerEntryError } from './errors';
import { newId } from './id';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  at: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  id: string;
}

/** Lançamento imutável: só campos readonly, nenhum método de transição, instância congelada. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    // Monta a instância primeiro para reaproveitar isBalanced(); se alguma regra falhar, o throw a descarta.
    const entry = WalletLedgerEntry.rehydrate({ ...props, id: newId() });
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be positive');
    }
    if (props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry cannot leave a negative balance');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced entry: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.at,
    );
  }

  /** balanceBefore ± money === balanceAfter (também lança CurrencyMismatchError se as moedas divergirem). */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
