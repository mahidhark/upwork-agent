/**
 * Email channel over SMTP.
 *
 * SMTP rather than a specific provider's API so that anyone cloning this can
 * point it at whatever they already have — a transactional provider, a Gmail
 * app password, a local relay.
 */
import nodemailer from 'nodemailer';
import type { Alert, AlertChannel } from './types.js';

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
};

export class EmailChannel implements AlertChannel {
  readonly name = 'email';

  private get settings() {
    return {
      to: env('ALERT_EMAIL_TO'),
      from: env('ALERT_EMAIL_FROM') ?? env('SMTP_USER'),
      host: env('SMTP_HOST'),
      port: Number(env('SMTP_PORT') ?? 587),
      user: env('SMTP_USER'),
      pass: env('SMTP_PASS'),
    };
  }

  configured(): boolean {
    const s = this.settings;
    return Boolean(s.to && s.host && s.from);
  }

  /** What is missing, for a clear message rather than a silent no-op. */
  missing(): string[] {
    const s = this.settings;
    return [
      !s.to && 'ALERT_EMAIL_TO',
      !s.host && 'SMTP_HOST',
      !s.from && 'ALERT_EMAIL_FROM (or SMTP_USER)',
    ].filter((x): x is string => Boolean(x));
  }

  async send(alert: Alert): Promise<void> {
    const s = this.settings;
    if (!this.configured()) throw new Error(`email not configured: ${this.missing().join(', ')}`);

    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.port === 465,
      ...(s.user && s.pass ? { auth: { user: s.user, pass: s.pass } } : {}),
    });

    await transport.sendMail({
      to: s.to,
      from: s.from,
      subject: `[upwork-agent] ${alert.subject}`,
      text: `${alert.body}\n\n--\nupwork-agent on ${process.env.HOSTNAME ?? 'staging'}\n`,
    });
  }
}
