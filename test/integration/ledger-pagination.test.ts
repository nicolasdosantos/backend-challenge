// Paginação do ledger por cursor (keyset em seq): percorre tudo sem repetir nem pular, inclusive com
// lançamentos novos entrando entre uma página e outra.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/wagering/process-wager-transaction';
import type { LedgerPage } from '../../src/wallets/wallet-queries';
import { createTestApp, type TestApp } from '../support/app';
import { expectLedgerConsistent } from '../support/invariants';
import { openWallet, wagerCommand, type TestWallet } from '../support/wagering';

let t: TestApp;
let useCase: ProcessWagerTransaction;
const touched: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
  useCase = t.app.get(ProcessWagerTransaction);
});

afterAll(async () => {
  await expectLedgerConsistent(t.orm, touched);
  await t.close();
});

async function addWins(w: TestWallet, count: number) {
  for (let i = 0; i < count; i++) {
    await useCase.execute(wagerCommand(w, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }));
  }
}

async function getPage(walletId: string, query: string): Promise<{ status: number; body: LedgerPage & { code?: string } }> {
  const response = await fetch(`${t.baseUrl}/wallets/${walletId}/ledger${query}`);
  return { status: response.status, body: (await response.json()) as LedgerPage & { code?: string } };
}

async function ledgerIdsInDb(walletId: string): Promise<string[]> {
  const rows = await t.orm.em
    .getConnection()
    .execute<{ id: string }[]>(`select id from wallet_ledger_entries where wallet_id = ? order by created_at, id`, [walletId]);
  return rows.map((r) => r.id);
}

describe('GET /wallets/:id/ledger (cursor)', () => {
  test('percorre tudo sem repetir nem pular, inclusive com inserções entre as páginas', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    await addWins(w, 15); // 1 OPENING + 15 WIN = 16 lançamentos

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { status, body }: { status: number; body: LedgerPage } = await getPage(w.id, `?limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(7);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      pages++;
      if (pages === 1) {
        await addWins(w, 5); // novas entradas chegam enquanto o cliente pagina
      }
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length); // nada repetido
    expect(seen).toEqual(await ledgerIdsInDb(w.id)); // nada pulado, na ordem
    expect(seen).toHaveLength(21);
  });

  test('itens no formato do contrato e limite padrão 50', async () => {
    const w = await openWallet(t, '100.00');
    touched.push(w.id);
    await addWins(w, 2);

    const { body } = await getPage(w.id, '');
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(3);
    expect(body.items[1] as unknown).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'CREDIT',
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '101.00', currency: 'BRL' },
      createdAt: expect.any(String),
    });
  });

  test.each([
    ['?cursor=lixo!!', 'cursor inválido'],
    [`?cursor=${Buffer.from('{"x":1}').toString('base64url')}`, 'cursor com JSON inesperado'],
    ['?limit=0', 'limit zero'],
    ['?limit=101', 'limit acima do máximo'],
    ['?limit=abc', 'limit não numérico'],
  ])('400 INVALID_PAYLOAD: %s (%s)', async (query) => {
    const w = await openWallet(t, '1.00');
    touched.push(w.id);
    const { status, body } = await getPage(w.id, query);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PAYLOAD');
  });
});
