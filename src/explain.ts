/**
 * Why did the agent do what it did with one job?
 *
 *   npm run explain -- <job-id or fragment>
 *
 * `npm run status` answers "how is the pipeline doing"; this answers "what
 * happened to *that* posting", which is the question an operator actually asks
 * when a job they found by hand never turned up in the agent's output.
 *
 * The important case is the one that prints nothing: a posting with no row was
 * never returned by any search profile, so no gate ever ran on it. That is a
 * coverage problem, and no amount of reading rejection reasons will show it —
 * which is exactly why it needs saying out loud rather than printing "not
 * found". A URL fragment works, so an id pasted out of a browser is enough.
 */
import { db } from './store/db.js';

const needle = process.argv[2];
if (!needle) {
  console.error('usage: npm run explain -- <job-id or fragment>');
  process.exit(1);
}

const q = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];
const one = <T>(sql: string, ...args: unknown[]): T | undefined =>
  db.prepare(sql).get(...args) as T | undefined;

interface Job {
  id: string;
  title: string;
  url: string | null;
  budget: number | null;
  job_type: string | null;
  proposal_count: number | null;
  created_date: string;
  first_seen_at: string;
  state: string;
  reject_reason: string | null;
  score: number | null;
  search_profile: string | null;
}

// Match on the url too: the id in a job URL carries a "~02" prefix and is the
// form that gets pasted, so requiring the bare id would reject the obvious input.
const jobs = q<Job>(
  `SELECT id, title, url, budget, job_type, proposal_count, created_date, first_seen_at,
          state, reject_reason, score, search_profile
     FROM jobs WHERE id LIKE ? OR url LIKE ? ORDER BY first_seen_at DESC`,
  `%${needle}%`,
  `%${needle}%`,
);

if (jobs.length === 0) {
  console.log(`\n  no job matching "${needle}" is in the database.`);
  console.log(`\n  That is not a rejection — it means no search profile ever returned this`);
  console.log(`  posting, so no gate ran on it. Postings that search does return are always`);
  console.log(`  recorded, stale ones included. Look at the profile queries, not the gates.\n`);
  process.exit(0);
}

if (jobs.length > 1) console.log(`\n  ${jobs.length} jobs match "${needle}"`);

for (const j of jobs) {
  const age = (Date.parse(j.first_seen_at) - Date.parse(j.created_date)) / 60000;
  const score = j.score == null ? '' : ` · score ${j.score.toFixed(1)}`;

  console.log(`\n  ${j.title}`);
  console.log(`  ${j.url ?? j.id}`);
  console.log(`  ${j.state}${score} · found by profile "${j.search_profile ?? '?'}"`);
  console.log(`  posted ${j.created_date} · first seen ${j.first_seen_at}`);
  console.log(
    `  ${Number.isFinite(age) ? `${age.toFixed(1)} min old at detection` : 'age unknown'}` +
      ` · ${j.job_type ?? '?'} · budget ${j.budget ?? '?'} · ${j.proposal_count ?? '?'} proposals when seen`,
  );
  if (j.reject_reason) console.log(`  reason: ${j.reject_reason}`);

  // Failures first: the answer to "why not" is one of these, and a passing gate
  // is only context for it.
  const gates = q<{ gate: string; passed: number; detail: string | null; checked_at: string }>(
    'SELECT gate, passed, detail, checked_at FROM screenings WHERE job_id = ? ORDER BY passed, gate',
    j.id,
  );

  if (gates.length === 0) {
    console.log(`\n  no screening rows — ingested, never screened.`);
  } else {
    console.log(`\n  GATES  (checked ${gates[0]!.checked_at})`);
    for (const g of gates) {
      console.log(`    ${g.passed ? 'pass' : 'FAIL'}  ${g.gate.padEnd(24)} ${g.detail ?? ''}`);
    }
  }

  const p = one<{
    proposal_id: string | null;
    bid: number;
    connects_cost: number | null;
    submitted_at: string | null;
    dry_run: number;
    len: number;
  }>(
    `SELECT proposal_id, bid, connects_cost, submitted_at, dry_run, length(cover_letter) AS len
       FROM proposals WHERE job_id = ?`,
    j.id,
  );

  if (p) {
    console.log(
      `\n  PROPOSAL ${p.proposal_id ?? '(no id)'} · bid ${p.bid}` +
        ` · ${p.connects_cost ?? '?'} connects · ${p.dry_run ? 'DRY RUN' : 'live'}` +
        ` · letter ${p.len} chars · ${p.submitted_at ?? 'not submitted'}`,
    );
  }
  console.log();
}
