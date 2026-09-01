/**
 * Raising an alert.
 *
 * Throttled per key, because an alert that fires on every poll is one the
 * operator learns to ignore. Delivery failures are recorded but never throw —
 * a broken mail server must not take the poller down with it.
 */
import { EmailChannel } from './email.js';
import type { Alert, AlertChannel } from './types.js';
import { minutesSinceAlert, recordAlert } from '../store/db.js';

const channels: AlertChannel[] = [new EmailChannel()];

export type RaiseResult = 'sent' | 'throttled' | 'unconfigured' | 'failed';

export async function raise(alert: Alert): Promise<RaiseResult> {
  const since = minutesSinceAlert(alert.key);
  if (since !== null && since < alert.throttleMinutes) {
    return 'throttled';
  }

  const active = channels.filter((c) => c.configured());
  if (active.length === 0) {
    // Loud on stdout so it is visible in pm2 logs even with no channel wired.
    console.error(`\n  ALERT (${alert.severity}, undeliverable) — ${alert.subject}`);
    console.error(`  ${alert.body.split('\n').join('\n  ')}`);
    const missing = new EmailChannel().missing();
    console.error(`  configure email to receive these: ${missing.join(', ')}\n`);
    return 'unconfigured';
  }

  let delivered = false;
  for (const channel of active) {
    try {
      await channel.send(alert);
      recordAlert(alert.key, alert.severity, alert.subject, channel.name);
      delivered = true;
      console.log(`  alert sent via ${channel.name}: ${alert.subject}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordAlert(alert.key, alert.severity, alert.subject, channel.name, message);
      console.error(`  alert delivery failed via ${channel.name}: ${message}`);
    }
  }
  return delivered ? 'sent' : 'failed';
}

// ----------------------------------------------------------------- builders

export function authRevoked(detail: string): Alert {
  return {
    key: 'auth_revoked',
    severity: 'critical',
    throttleMinutes: 60,
    subject: 'Upwork connection is no longer working',
    body: [
      'The agent can no longer act on your Upwork account, so it is not seeing',
      'jobs at all until this is fixed.',
      '',
      `Reported: ${detail}`,
      '',
      'Most likely causes: access was revoked under Upwork → Settings →',
      'Connected Apps, or the refresh token expired.',
      '',
      'To fix: open the authorization page and click Connect Upwork again.',
    ].join('\n'),
  };
}

export function connectsLow(balance: number, floor: number, costPerBid: number): Alert {
  const bidsLeft = costPerBid > 0 ? Math.floor(balance / costPerBid) : 0;
  return {
    key: 'connects_low',
    severity: 'warning',
    throttleMinutes: 12 * 60,
    subject: `Connects low — ${balance} left`,
    body: [
      `Balance is ${balance} Connects, below the floor of ${floor}.`,
      '',
      `At roughly ${costPerBid} Connects per application that is about ${bidsLeft} more bids.`,
      '',
      'The agent stops drafting once the balance would fall below the reserve,',
      'so it will go quiet rather than spend the last of them.',
      '',
      'Top up under Upwork → Settings → Connects.',
    ].join('\n'),
  };
}
