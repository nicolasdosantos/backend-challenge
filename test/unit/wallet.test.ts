import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, DomainError, InsufficientFundsError, InvalidLedgerEntryError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { brl } from '../support/builders';

const at = new Date('2026-10-10T12:00:00Z');
const ctx = { transactionId: 'tx-1', at };

function openWallet(amount = '100.00') {
  return Wallet.open({ playerId: 'player-1', initialBalance: brl(amount), at });
}

describe('Wallet', () => {
  test('abre com saldo inicial, moeda do saldo e version 1', () => {
    const wallet = openWallet('100.00');
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
  });

  test('openingEntry credita de 0 até o saldo inicial sem mudar a version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.openingEntry(ctx);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('0.00');
    expect(entry.balanceAfter.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('wallet com saldo zero não tem lançamento de abertura', () => {
    expect(() => openWallet('0.00').openingEntry(ctx)).toThrow(InvalidLedgerEntryError);
  });

  test('debit reduz o saldo, incrementa a version e devolve o lançamento correspondente', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('80.00'), ctx);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.walletId).toBe(wallet.id);
  });

  test('credit aumenta o saldo e incrementa a version', () => {
    const wallet = openWallet('100.00');
    wallet.credit(brl('50.00'), ctx);
    expect(wallet.balance.amount).toBe('150.00');
    expect(wallet.version).toBe(2);
  });

  test('saldo nunca fica negativo: debit maior que o saldo lança erro e não altera nada', () => {
    const wallet = openWallet('100.00');
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(() => wallet.debit(brl('100.01'), ctx)).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('debit exatamente igual ao saldo zera a wallet', () => {
    const wallet = openWallet('80.00');
    wallet.debit(brl('80.00'), ctx);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('duas apostas de 80 com saldo 100: só a primeira passa (cenário §8, sem concorrência)', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('80.00'), ctx);
    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(wallet.balance.amount).toBe('20.00');
  });

  test('moeda da operação diferente da wallet é recusada', () => {
    const wallet = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, ctx)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, ctx)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('debit/credit de valor zero são recusados (não existe lançamento sem movimento)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(brl('0.00'), ctx)).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  test('playerId é obrigatório', () => {
    expect(() => Wallet.open({ playerId: '', initialBalance: brl('1.00'), at })).toThrow(DomainError);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('5.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    walletId: 'w1',
    transactionId: 't1',
    direction: LedgerDirection.Credit,
    money: brl('10.00'),
    balanceBefore: brl('5.00'),
    balanceAfter: brl('15.00'),
    at,
  };

  test('create valida a aritmética do lançamento', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('16.00') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit })).toThrow(InvalidLedgerEntryError);
  });

  test('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow(TypeError);
  });

  test('moedas divergentes no lançamento são recusadas', () => {
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => WalletLedgerEntry.create({ ...base, money: usd })).toThrow(CurrencyMismatchError);
  });
});
