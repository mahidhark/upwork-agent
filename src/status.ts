/**
 * One-shot status report.
 *
 *   npm run status
 *
 * The number that matters is age at detection: how old a posting was when we
 * first saw it. Everything downstream is wasted if that distribution sits
 * outside the window we are aiming at.
 */
import { db } from './store/db.js';
import { loadConfig } from './search-profiles.js';

const config = loadConfig();

const q = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];
const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;

const totals = one<{ n: number }>('SELECT COUNT(*) AS n FROM jobs');
const byState = q<{ state: string; n: number }>(
  'SELECT state, COUNT(*) AS n FROM jobs GROUP BY state ORDER BY n DESC',
);
const lastRun = one<{ started_at: string; profile: string } | undefined>(
  'SELECT started_at, profile FROM runs ORDER BY id DESC LIMIT 1',
);

console.log(`\n  upwork-agent status\n`);
console.log(`  poll every ${config.pollIntervalSeconds}s · ignore postings older than ${config.screen.maxAgeMinutes} min`);
console.log(`  last poll   ${lastRun?.started_at ?? 'never'}`);
console.log(`  jobs seen   ${totals.n}`);
console.log(`  ${byState.map((s) => `${s.state} ${s.n}`).join(' · ') || 'none'}\n`);

// --- age at detection: the number the whole strategy rests on
// Computed in JS, not SQL: Upwork returns "+0000" offsets, which SQLite's
// julianday() silently fails to parse — it returns null rather than erroring.
// Only jobs we actually caught in flight. Bootstrap rows are inserted as
// 'seen' and never processed, so they would otherwise swamp the distribution
// with postings that were already days old when the database was created.
const ages = q<{ created_date: string; first_seen_at: string }>(
  "SELECT created_date, first_seen_at FROM jobs WHERE created_date IS NOT NULL AND state != 'seen'",
)
  .map((r) => (Date.parse(r.first_seen_at) - Date.parse(r.created_date)) / 60000)
  .filter((m) => Number.isFinite(m) && m >= 0)
  .sort((a, b) => a - b);

if (ages.length === 0) {
  console.log('  no age data yet\n');
} else {
  const pct = (p: number) => ages[Math.min(ages.length - 1, Math.floor((ages.length - 1) * p))]!;
  const within = (m: number) => ages.filter((a) => a <= m).length;
  console.log(`  AGE AT DETECTION  (n=${ages.length})`);
  console.log(`    median ${pct(0.5).toFixed(1)} min · p90 ${pct(0.9).toFixed(1)} min`);
  for (const m of [3, 5, 10, 30]) {
    const n = within(m);
    const bar = '█'.repeat(Math.round((n / ages.length) * 30));
    console.log(`    within ${String(m).padStart(2)} min  ${String(n).padStart(4)}  ${((n / ages.length) * 100).toFixed(0).padStart(3)}%  ${bar}`);
  }
  console.log();
}

const pending = q<{ title: string; score: number; proposal_count: number; created_date: string }>(
  `SELECT title, score, proposal_count, created_date FROM jobs
   WHERE state = 'scored' ORDER BY score DESC LIMIT 8`,
);
if (pending.length) {
  console.log(`  SCORED, AWAITING A DRAFT`);
  for (const p of pending) {
    console.log(`    ${(p.score ?? 0).toFixed(1).padStart(5)}  ${p.proposal_count ?? '?'} props  ${p.title.slice(0, 52)}`);
  }
  console.log();
}

const rejects = q<{ reason: string; n: number }>(`
  SELECT gate AS reason, COUNT(*) AS n FROM screenings WHERE passed = 0 GROUP BY gate ORDER BY n DESC LIMIT 8
`);
if (rejects.length) {
  console.log(`  TOP REJECTION REASONS`);
  for (const r of rejects) console.log(`    ${String(r.n).padStart(4)}  ${r.reason}`);
  console.log();
}
