import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * Valida que um processo filho criado com Bun.spawn recebe SIGTERM, termina o trabalho em
 * andamento e sai com código 0. Base para os testes de shutdown gracioso e crash.
 * No Windows não há entrega de SIGTERM (o kill é forçado), por isso o teste roda em Linux:
 * `docker compose run --rm tests`.
 */
describe.skipIf(process.platform === 'win32')('sinais POSIX com Bun.spawn', () => {
  test('SIGTERM é entregue e o processo encerra graciosamente', async () => {
    const child = Bun.spawn(['bun', join(import.meta.dir, 'fixtures', 'graceful-child.ts')], { stdout: 'pipe' });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (!output.includes('ready')) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }

    child.kill('SIGTERM');
    const exitCode = await child.exited;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      output += decoder.decode(chunk.value);
    }

    expect(output).toContain('sigterm-received');
    expect(output).toContain('graceful-exit');
    expect(exitCode).toBe(0);
  });

  test('SIGKILL encerra imediatamente, sem chance de limpeza (simula crash)', async () => {
    const child = Bun.spawn(['bun', join(import.meta.dir, 'fixtures', 'graceful-child.ts')], { stdout: 'pipe' });
    await Bun.sleep(200);
    child.kill('SIGKILL');
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
  });
});
