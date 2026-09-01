/**
 * SQLite state. Versioned from v1 rather than retrofitted (finding 9.b).
 *
 * Job lifecycle (requirements §8):
 *   seen → screened → {rejected | scored} → drafted → submitted
 * Defined once here and read by every surface, so nothing invents its own
 * terminal set (finding 7.a).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from '../config.js';

export const JOB_STATES = [
  'seen',
  'screened',
  'rejected',
  'scored',
  'drafted',
  'submitted',
  'failed',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** States from which nothing further happens. */
export const TERMINAL_STATES: readonly JobState[] = ['rejected', 'submitted', 'failed'];

mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const MIGRATIONS: Array<{ version: number; up: string }> = [
  {
    version: 1,
    up: `
      CREATE TABLE jobs (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        url             TEXT,
        budget          REAL,
        job_type        TEXT,
        proposal_count  INTEGER,
        created_date    TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL,
        state           TEXT NOT NULL,
        reject_reason   TEXT,
        score           REAL,
        search_profile  TEXT,
        raw             TEXT NOT NULL
      );
      CREATE INDEX jobs_state ON jobs(state);
      CREATE INDEX jobs_created ON jobs(created_date);

      CREATE TABLE screenings (
        job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        gate        TEXT NOT NULL,
        passed      INTEGER NOT NULL,
        detail      TEXT,
        checked_at  TEXT NOT NULL,
        PRIMARY KEY (job_id, gate)
      );

      CREATE TABLE proposals (
        job_id        TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        proposal_id   TEXT,
        draft_id      TEXT,
        cover_letter  TEXT NOT NULL,
        bid           REAL NOT NULL,
        connects_cost INTEGER,
        boost         INTEGER NOT NULL DEFAULT 0,
        chunks        TEXT,
        submitted_at  TEXT,
        dry_run       INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE outcomes (
        proposal_id   TEXT PRIMARY KEY,
        checked_at    TEXT NOT NULL,
        insights      TEXT NOT NULL
      );

      CREATE TABLE runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at    TEXT NOT NULL,
        profile       TEXT NOT NULL,
        seen          INTEGER NOT NULL DEFAULT 0,
        new_jobs      INTEGER NOT NULL DEFAULT 0,
        error         TEXT
      );
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE alerts (
        key         TEXT NOT NULL,
        severity    TEXT NOT NULL,
        subject     TEXT NOT NULL,
        sent_at     TEXT NOT NULL,
        channel     TEXT NOT NULL,
        error       TEXT
      );
      CREATE INDEX alerts_key_sent ON alerts(key, sent_at);
    `,
  },
];

function migrate(): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  const current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
  }
}
migrate();

export interface JobRow {
  id: string;
  title: string;
  url: string | null;
  budget: number | null;
  job_type: string | null;
  proposal_count: number | null;
  created_date: string;
  first_seen_at: string;
  state: JobState;
  reject_reason: string | null;
  score: number | null;
  search_profile: string | null;
  raw: string;
}

const insertJob = db.prepare(`
  INSERT INTO jobs (id, title, url, budget, job_type, proposal_count, created_date,
                    first_seen_at, state, search_profile, raw)
  VALUES (@id, @title, @url, @budget, @job_type, @proposal_count, @created_date,
          @first_seen_at, @state, @search_profile, @raw)
  ON CONFLICT(id) DO NOTHING
`);

/** Returns true when this job had not been seen before. FR-2. */
export function recordSeen(job: {
  id: string;
  title: string;
  url?: string;
  budget?: string | number;
  job_type?: string;
  proposal_count?: number;
  created_date: string;
  raw: unknown;
  profile: string;
  state?: JobState;
}): boolean {
  const result = insertJob.run({
    id: job.id,
    title: job.title,
    url: job.url ?? null,
    budget: job.budget == null ? null : Number(job.budget),
    job_type: job.job_type ?? null,
    proposal_count: job.proposal_count ?? null,
    created_date: job.created_date,
    first_seen_at: new Date().toISOString(),
    state: job.state ?? 'seen',
    search_profile: job.profile,
    raw: JSON.stringify(job.raw),
  });
  return result.changes > 0;
}

export function setState(id: string, state: JobState, rejectReason?: string): void {
  db.prepare('UPDATE jobs SET state = ?, reject_reason = ? WHERE id = ?').run(
    state,
    rejectReason ?? null,
    id,
  );
}

/** The resolved count, once screening has decided between reported and inferred. */
export function setProposalCount(id: string, count: number | null): void {
  db.prepare('UPDATE jobs SET proposal_count = ? WHERE id = ?').run(count, id);
}

export function setScore(id: string, score: number): void {
  db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(score, id);
}

export function recordGate(jobId: string, gate: string, passed: boolean, detail?: string): void {
  db.prepare(
    `INSERT INTO screenings (job_id, gate, passed, detail, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id, gate) DO UPDATE SET passed = excluded.passed,
       detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(jobId, gate, passed ? 1 : 0, detail ?? null, new Date().toISOString());
}

export function jobsInState(state: JobState): JobRow[] {
  return db
    .prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_date DESC')
    .all(state) as JobRow[];
}

export function isEmpty(): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
  return row.n === 0;
}

/** Proposals submitted since a UTC timestamp — FR-9 daily spend guard. */
export function submittedSince(isoTimestamp: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM proposals WHERE submitted_at IS NOT NULL AND submitted_at >= ?',
    )
    .get(isoTimestamp) as { n: number };
  return row.n;
}

export function startRun(profile: string): number {
  const info = db
    .prepare('INSERT INTO runs (started_at, profile) VALUES (?, ?)')
    .run(new Date().toISOString(), profile);
  return Number(info.lastInsertRowid);
}

export function finishRun(id: number, seen: number, newJobs: number, error?: string): void {
  db.prepare('UPDATE runs SET seen = ?, new_jobs = ?, error = ? WHERE id = ?').run(
    seen,
    newJobs,
    error ?? null,
    id,
  );
}

// ------------------------------------------------------------------- alerts

/** Minutes since this alert key was last sent successfully, or null if never. */
export function minutesSinceAlert(key: string): number | null {
  const row = db
    .prepare("SELECT sent_at FROM alerts WHERE key = ? AND error IS NULL ORDER BY sent_at DESC LIMIT 1")
    .get(key) as { sent_at: string } | undefined;
  if (!row) return null;
  return (Date.now() - Date.parse(row.sent_at)) / 60000;
}

export function recordAlert(
  key: string,
  severity: string,
  subject: string,
  channel: string,
  error?: string,
): void {
  db.prepare(
    'INSERT INTO alerts (key, severity, subject, sent_at, channel, error) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(key, severity, subject, new Date().toISOString(), channel, error ?? null);
}
