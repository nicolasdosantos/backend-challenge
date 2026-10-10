import DecimalJs from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// Instância própria do decimal.js para não depender de configuração global.
const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_EVEN });
type Decimal = InstanceType<typeof Decimal>;

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
// Sem sinal, sem notação científica, sem zeros à esquerda, até 2 casas.
// Até 18 dígitos inteiros, o limite da coluna numeric(20,2).
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Entrada de contrato: rejeita negativos, mais de 2 casas e qualquer formato não decimal. */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid amount "${String(props.amount)}"`);
    }
    return new Money(new Decimal(props.amount), Money.validCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.validCurrency(currency));
  }

  private static validCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}"`);
    }
    return currency;
  }

  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
