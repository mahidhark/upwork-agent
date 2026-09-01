/**
 * Ingest loop (requirements FR-1 to FR-6).
 *
 *   search → dedupe → freshness → per-job fetch → screen → record
 *
 * Nothing here writes to Upwork. It reads, judges, and records what it judged,
 * so the scoring and drafting stages have something auditable to sit on.
 *
 *   npm run poll -- --once
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { loadConfig, type AgentConfig, type SearchProfile } from '../search-profiles.js';
import { FileAuthProvider } from '../auth/provider.js';
import { connect } from '../mcp/client.js';
import { searchJobs, getJob, connectsBalance, firstOrgUid, type SearchHit } from '../mcp/upwork.js';
import { screen, passed, failures } from '../screen/gates.js';
import {
  recordSeen,
  recordGate,
  setState,
  isEmpty,
  startRun,
  finishRun,
} from '../store/db.js';

export interface PollSummary {
  seen: number;
  fresh: number;
  screened: number;
  accepted: number;
  rejected: number;
  bootstrapped: boolean;
}

const ageMinutes = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 60000;

/** Page only while every hit on the page is new — otherwise we have caught up (finding 1.a). */
async function collect(
  client: Client,
  orgUid: string,
  profile: SearchProfile,
  maxPages: number,
): Promise<{ hits: SearchHit[]; newIds: Set<string> }> {
  const hits: SearchHit[] = [];
  const newIds = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const { name, ...params } = profile;
    const result = await searchJobs(client, orgUid, { ...params, cursor });
    if (result.jobs.length === 0) break;

    let allNew = true;
    for (const hit of result.jobs) {
      hits.push(hit);
      const isNew = recordSeen({
        id: hit.id,
        title: hit.title,
        url: hit.url,
        budget: hit.budget,
        job_type: hit.job_type,
        proposal_count: hit.proposal_count,
        created_date: hit.created_date,
        raw: hit,
        profile: name,
      });
      if (isNew) newIds.add(hit.id);
      else allNew = false;
    }

    if (!allNew || !result.hasMore || !result.endCursor) break;
    cursor = result.endCursor;
  }

  return { hits, newIds };
}

export async function pollOnce(
  client: Client,
  orgUid: string,
  config: AgentConfig,
  now = new Date(),
): Promise<PollSummary> {
  // FR-3: on a cold start, take everything currently listed as already seen.
  // Page size caps at 10, so a backlog cannot be assumed to fit in one page.
  const bootstrapping = isEmpty();

  const summary: PollSummary = {
    seen: 0,
    fresh: 0,
    screened: 0,
    accepted: 0,
    rejected: 0,
    bootstrapped: bootstrapping,
  };

  const candidates: SearchHit[] = [];

  for (const profile of config.profiles) {
    const runId = startRun(profile.name);
    try {
      const { hits, newIds } = await collect(client, orgUid, profile, config.maxPagesPerProfile);
      summary.seen += hits.length;
      finishRun(runId, hits.length, newIds.size);
      if (bootstrapping) continue;
      for (const hit of hits) if (newIds.has(hit.id)) candidates.push(hit);
    } catch (err) {
      finishRun(runId, 0, 0, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  if (bootstrapping) return summary;

  // FR-4: drop stale postings before spending a fetch on them. Position in the
  // list is a function of elapsed time, so an old posting is not worth a call.
  const fresh = candidates.filter(
    (hit) => ageMinutes(hit.created_date, now) <= config.screen.maxAgeMinutes,
  );
  summary.fresh = fresh.length;
  for (const stale of candidates) {
    if (!fresh.includes(stale)) setState(stale.id, 'rejected', 'stale on arrival');
  }
  if (fresh.length === 0) return summary;

  const balance = (await connectsBalance(client, orgUid)).connectsBalance;

  for (const hit of fresh) {
    try {
      const detail = await getJob(client, orgUid, hit.id);
      // get carries neither the posting date nor the pool size; search does.
      detail.createdDate = hit.created_date;
      detail.proposalCount = hit.proposal_count ?? null;

      const outcomes = screen(detail, balance, now, config.screen);
      for (const o of outcomes) recordGate(hit.id, o.gate, o.passed, o.detail);
      summary.screened++;

      if (passed(outcomes)) {
        setState(hit.id, 'scored');
        summary.accepted++;
      } else {
        setState(hit.id, 'rejected', failures(outcomes).map((f) => `${f.gate}: ${f.detail}`).join('; '));
        summary.rejected++;
      }
    } catch (err) {
      setState(hit.id, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  return summary;
}

// ------------------------------------------------------------------- runner
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(once: boolean): Promise<void> {
  const config = loadConfig();
  const provider = new FileAuthProvider();
  if (!provider.isConnected()) {
    throw new Error('not authorized — run `npm run auth` and connect first');
  }

  const client = await connect(provider);
  const orgUid = await firstOrgUid(client);
  const base = config.pollIntervalSeconds * 1000;
  let backoff = base;

  console.log(`  polling ${config.profiles.length} profiles every ${config.pollIntervalSeconds}s`);

  for (;;) {
    const started = Date.now();
    try {
      const s = await pollOnce(client, orgUid, config);
      backoff = base;
      const line = s.bootstrapped
        ? `bootstrap — ${s.seen} existing postings marked seen, none processed`
        : `${s.seen} seen · ${s.fresh} fresh · ${s.screened} screened · ${s.accepted} accepted · ${s.rejected} rejected`;
      console.log(`  ${new Date().toISOString()}  ${line}`);
    } catch (err) {
      // NFR-3: no documented rate limit, so back off rather than retry blind.
      console.error(`  ${new Date().toISOString()}  poll failed: ${err instanceof Error ? err.message : String(err)}`);
      backoff = Math.min(backoff * 2, 30 * 60 * 1000);
      console.error(`  backing off to ${Math.round(backoff / 1000)}s`);
    }
    if (once) break;
    await sleep(Math.max(0, backoff - (Date.now() - started)));
  }

  await client.close();
}

const isMain = process.argv[1]?.endsWith('poll.ts');
if (isMain) {
  run(process.argv.includes('--once')).catch((err) => {
    console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
