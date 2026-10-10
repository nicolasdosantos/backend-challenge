import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test.each([
    ['25.00', '25.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('aceita "%s" e serializa com escala fixa 2 como "%s"', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  test.each([
    ['', 'string vazia'],
    ['abc', 'texto'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['1e3', 'notação científica'],
    ['1E-2', 'notação científica'],
    ['-1.00', 'negativo'],
    ['1.001', 'mais de 2 casas'],
    ['1.', 'ponto sem casas'],
    ['.50', 'sem parte inteira'],
    ['01.00', 'zero à esquerda'],
    [' 1.00', 'espaço'],
    ['1,00', 'vírgula'],
    ['1000000000000000000.00', 'acima de numeric(20,2)'],
  ])('rejeita "%s" (%s)', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (ex.: number)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRLX', '123'])('rejeita moeda inválida "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('aritmética decimal exata (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('0.30').subtract(brl('0.10')).subtract(brl('0.20')).isZero()).toBe(true);
  });

  test('é imutável: operações retornam novas instâncias', () => {
    const original = brl('10.00');
    const result = original.add(brl('5.00'));
    expect(original.amount).toBe('10.00');
    expect(result).not.toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
  });

  test('negate e subtract podem gerar valor negativo internamente', () => {
    expect(brl('10.00').negate().amount).toBe('-10.00');
    expect(brl('10.00').subtract(brl('15.00')).isNegative()).toBe(true);
  });

  test('comparações', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.01'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('zero, toJSON e toString', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(JSON.stringify({ money: brl('25') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
