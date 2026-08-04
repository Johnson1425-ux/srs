/**
 * Outcome for one recipient of one send.
 *
 * Shared by every channel: SMS and email fail in different ways but the
 * dispatcher only needs to know whether it went, and whether trying again
 * could plausibly help.
 */
export interface DeliveryResult {
  recipient: string;
  /** Accepted by the gateway or mail server for delivery. */
  accepted: boolean;
  /** The provider's own id, kept so a delivery report can be matched later. */
  providerRef?: string;
  /** What it cost, as the provider reported it (e.g. "TZS 0.8000"). */
  cost?: string;
  error?: string;
  /**
   * Whether trying again could plausibly succeed. An invalid number or a
   * rejected mailbox never will; a timeout might. Retrying the former only
   * burns attempts.
   */
  retryable: boolean;
}

export type SmsResult = DeliveryResult;

export interface SmsPayload {
  recipient: string;
  body: string;
}

export interface SmsProvider {
  readonly name: string;
  /**
   * Sends a batch. Implementations must return one result per recipient, in
   * any order, and must not throw for per-recipient failures — a bad number in
   * a batch of two hundred should not fail the other hundred and ninety-nine.
   */
  send(messages: SmsPayload[], senderId: string): Promise<SmsResult[]>;
}

export type EmailResult = DeliveryResult;

export interface EmailPayload {
  recipient: string;
  subject: string;
  body: string;
  /** Where a reply should go — the school's own address, not the relay's. */
  replyTo?: string;
}

export interface EmailProvider {
  readonly name: string;
  /**
   * Sends a batch, one result per message in the same order — email is
   * addressed individually, so unlike SMS the same address can legitimately
   * appear twice with different subjects and must not be collapsed.
   */
  send(messages: EmailPayload[], from: string): Promise<EmailResult[]>;
  /** Releases any pooled connection. Called on shutdown. */
  close?(): Promise<void>;
}
