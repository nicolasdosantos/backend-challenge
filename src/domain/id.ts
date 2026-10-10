/** UUID v7: ordenável pelo tempo de criação, o que ajuda índices e paginação por cursor. */
export function newId(): string {
  return Bun.randomUUIDv7();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Evita mandar ao PostgreSQL um id que a coluna uuid recusaria com erro de sintaxe. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
