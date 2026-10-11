import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

/**
 * Eliminatório "number para dinheiro": varredura estática do código de produção. Dinheiro só
 * circula como string decimal ou como `Money` (decimal.js); nunca é convertido para number.
 */
const SRC = join(import.meta.dir, '..', '..', 'src');
const MONEY_WORDS = '(amount|balance|money|credits|debits|difference)';

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Glob('**/*.ts').scan(SRC)) {
    files.push({ path, text: await Bun.file(join(SRC, path)).text() });
  }
  return files;
}

describe('dinheiro nunca vira number', () => {
  test('sem parseFloat/parseInt no código de produção', async () => {
    const offenders = (await sourceFiles()).filter((f) => /\bparse(Float|Int)\s*\(/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test('sem Number(...)/+x/Math.* aplicado a valores monetários', async () => {
    const pattern = new RegExp(`(Number\\(|Math\\.\\w+\\()[^)]*${MONEY_WORDS}`, 'i');
    const offenders = (await sourceFiles()).flatMap((f) =>
      f.text
        .split('\n')
        .map((line, i) => ({ line: line.trim(), where: `${f.path}:${i + 1}` }))
        .filter(({ line }) => pattern.test(line))
        .map(({ where, line }) => `${where} ${line}`),
    );
    expect(offenders).toEqual([]);
  });

  test('nenhum campo monetário tipado como number', async () => {
    const pattern = new RegExp(`\\b\\w*${MONEY_WORDS}\\w*\\s*[?!]?:\\s*number\\b`, 'i');
    const offenders = (await sourceFiles()).flatMap((f) =>
      f.text
        .split('\n')
        .map((line, i) => ({ line: line.trim(), where: `${f.path}:${i + 1}` }))
        .filter(({ line }) => pattern.test(line))
        .map(({ where, line }) => `${where} ${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
