/** Outcome for one recipient of one send. */
export interface SmsResult {
  recipient: string;
  /** Accepted by the gateway for delivery. */
  accepted: boolean;
  /** The gateway's own id, kept so a delivery report can be matched later. */
  providerRef?: string;
  /** What it cost, as the gateway reported it (e.g. "TZS 0.8000"). */
  cost?: string;
  error?: string;
  /**
   * Whether trying again could plausibly succeed. An invalid number never
   * will; a gateway timeout might. Retrying the former only burns attempts.
   */
  retryable: boolean;
}

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
