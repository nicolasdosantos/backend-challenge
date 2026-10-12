// Outbox: evento de integração esperando publicação. Entra no banco junto com a mudança de negócio
// (mesmo commit) e só depois é enviado ao SQS pelo OutboxPublisher.

import { DomainError } from './errors';
import type { IntegrationEvent } from './integration-events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Evento aguardando publicação. Gravado na mesma transação SQL da alteração de negócio. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId, que também serve de MessageDeduplicationId no SQS. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // Ida e volta pelo JSON: o payload guardado já é exatamente o corpo que vai para a fila (datas em ISO, sem undefined).
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Ainda não publicado e sem tentativa agendada para depois de `now`. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new DomainError(`Outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial (1s, 2s, 4s… até 5 min). */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (this._attempts - 1), MAX_RETRY_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
