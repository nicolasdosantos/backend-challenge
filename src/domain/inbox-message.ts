import { DomainError } from './errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  at: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/** Registro de mensagem recebida, único por (consumerName, messageId). Dedup de transporte. */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName) {
      throw new DomainError('messageId and consumerName are required');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.at);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.at, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainError(`Inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }
}
