import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../../config/env.js';
import type { EmailPayload, EmailProvider, EmailResult } from './types.js';

/**
 * Mail servers answer with a three-digit reply code, and its first digit is
 * the whole story: 5xx is a permanent rejection ("no such mailbox"), 4xx is a
 * temporary one ("try later, I am busy"). Anything else — a socket that never
 * opened, a name that would not resolve — decided nothing, so it is worth
 * another go.
 */
function classify(err: unknown): { error: string; retryable: boolean } {
  const e = err as { responseCode?: number; code?: string; message?: string; response?: string };
  const detail = e.response ?? e.message ?? 'Send failed';

  if (typeof e.responseCode === 'number') {
    const permanent = e.responseCode >= 500 && e.responseCode < 600;
    return { error: `${detail} (${e.responseCode})`, retryable: !permanent };
  }

  switch (e.code) {
    // Wrong credentials, or an envelope the server refused outright. Repeating
    // the request cannot change either.
    case 'EAUTH':
    case 'EENVELOPE':
      return { error: `${detail} (${e.code})`, retryable: false };
    default:
      return { error: detail, retryable: true };
  }
}

/** The slice of a transporter this provider uses. */
export interface MailTransport {
  sendMail(options: Record<string, unknown>): Promise<unknown>;
  close?(): void;
}

export interface SmtpOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  /** Overrides how the transport is built — the seam tests connect to. */
  createTransport?: () => MailTransport;
}

export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';

  private transporter: MailTransport | null = null;
  private readonly options: Required<Pick<SmtpOptions, 'host' | 'port' | 'secure'>> & SmtpOptions;

  constructor(options: SmtpOptions = {}) {
    this.options = {
      host: options.host ?? env.SMTP_HOST ?? '',
      port: options.port ?? env.SMTP_PORT,
      secure: options.secure ?? env.SMTP_SECURE,
      user: options.user ?? env.SMTP_USER,
      password: options.password ?? env.SMTP_PASSWORD,
      createTransport: options.createTransport,
    };
  }

  private connection(): MailTransport {
    // Pooled, so a bulk send to four hundred parents opens one connection
    // rather than four hundred. Built lazily: constructing it eagerly would
    // dial the mail server at import time, including in tests.
    this.transporter ??=
      this.options.createTransport?.() ??
      (nodemailer.createTransport({
        host: this.options.host,
        port: this.options.port,
        secure: this.options.secure,
        auth: this.options.user
          ? { user: this.options.user, pass: this.options.password }
          : undefined,
        pool: true,
        maxConnections: 3,
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 30_000,
      }) as Transporter as MailTransport);
    return this.transporter;
  }

  async send(messages: EmailPayload[], from: string): Promise<EmailResult[]> {
    if (messages.length === 0) return [];

    const transporter = this.connection();
    const results: EmailResult[] = [];

    // Sequential rather than parallel: a pool of three is the concurrency
    // limit anyway, and mail servers rate-limit a burst from one client more
    // readily than a steady stream.
    for (const message of messages) {
      try {
        const info = (await transporter.sendMail({
          from,
          to: message.recipient,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.body,
        })) as { messageId?: string; rejected?: Array<string | { address: string }> };

        // A server can accept the connection and still refuse the recipient,
        // which resolves rather than throws.
        const rejected = (info.rejected ?? []).map((r) =>
          typeof r === 'string' ? r : r.address,
        );
        if (rejected.includes(message.recipient)) {
          results.push({
            recipient: message.recipient,
            accepted: false,
            error: 'Recipient rejected by the mail server',
            retryable: false,
          });
          continue;
        }

        results.push({
          recipient: message.recipient,
          accepted: true,
          providerRef: info.messageId,
          retryable: false,
        });
      } catch (err) {
        const { error, retryable } = classify(err);
        results.push({ recipient: message.recipient, accepted: false, error, retryable });
      }
    }

    return results;
  }

  async close(): Promise<void> {
    this.transporter?.close?.();
    this.transporter = null;
  }
}
