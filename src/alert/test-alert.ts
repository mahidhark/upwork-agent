/**
 * Send a test alert, to prove delivery works before relying on it.
 *
 *   npm run alert:test
 *
 * Bypasses throttling — this is a deliberate manual check, not a real event.
 */
import { EmailChannel } from './email.js';

const channel = new EmailChannel();

if (!channel.configured()) {
  console.error(`\n  Email is not configured. Missing: ${channel.missing().join(', ')}`);
  console.error(`\n  Add to .env:`);
  console.error(`    ALERT_EMAIL_TO=you@example.com`);
  console.error(`    ALERT_EMAIL_FROM=agent@example.com`);
  console.error(`    SMTP_HOST=smtp.example.com`);
  console.error(`    SMTP_PORT=587`);
  console.error(`    SMTP_USER=...`);
  console.error(`    SMTP_PASS=...\n`);
  process.exit(1);
}

await channel.send({
  key: 'auth_revoked',
  severity: 'warning',
  throttleMinutes: 0,
  subject: 'Test alert',
  body: [
    'This is a test. Nothing is wrong.',
    '',
    'If you are reading this, alert delivery works and the agent can reach you',
    'when the Upwork connection breaks or Connects run low.',
  ].join('\n'),
});

console.log('\n  Test alert sent. Check your inbox.\n');
