/**
 * Applying to a job — the shared path used by both the poller and the CLI.
 *
 * Returns a result rather than exiting, so the poller can carry on after a
 * refusal. Every guard here is a refusal, not a warning: with nobody reading
 * the letter before it goes, a warning is a log line no one sees.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { STORE_DIR } from '../config.js';
import type { AgentConfig } from '../search-profiles.js';
import type { JobDetail } from '../screen/gates.js';
import { screen, passed, failures } from '../screen/gates.js';
import { createProposal, confirmProposal, preflight } from '../mcp/upwork.js';
import { loadCorpus, retrieve, render } from '../draft/corpus.js';
import { extractInstructions } from '../draft/instructions.js';
import { composeLetter } from '../draft/compose.js';
import { verifyLetter } from '../draft/verify.js';
import { answerScreeningQuestions } from '../draft/answers.js';
import { decideBoost } from './boost.js';
import { chooseBid } from './bid.js';
import { recordProposal, submittedSince, setState } from '../store/db.js';

/** A file that stops submission without stopping ingest. */
export const KILL_SWITCH = join(STORE_DIR, 'STOP');

export interface ApplyOptions {
  live: boolean;
  /** Overrides the automatic choice. */
  bid?: number;
}

export interface ApplyResult {
  outcome: 'submitted' | 'dry_run' | 'refused' | 'failed';
  reason?: string;
  proposalId?: string;
  letter?: string;
  bid?: number;
  connectsCost?: number;
  boost?: number;
  chunks?: string[];
}

const refused = (reason: string): ApplyResult => ({ outcome: 'refused', reason });

export async function applyToJob(
  client: Client,
  orgUid: string,
  job: JobDetail,
  balance: number,
  config: AgentConfig,
  opts: ApplyOptions,
  log: (line: string) => void = () => {},
): Promise<ApplyResult> {
  if (opts.live && existsSync(KILL_SWITCH)) {
    return refused(`kill switch present at ${KILL_SWITCH}`);
  }

  // FR-9, checked before anything spends a call.
  if (opts.live) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const sent = submittedSince(since);
    const cap = config.screen.maxPerDay ?? 3;
    if (sent >= cap) return refused(`${sent} proposals in 24h, cap is ${cap}`);
  }

  // A posting can be filled or edited since ingest — never submit against a
  // stale verdict.
  const outcomes = screen(job, balance, new Date(), config.screen);
  if (!passed(outcomes)) {
    return refused(failures(outcomes).map((f) => `${f.gate} (${f.detail})`).join('; '));
  }

  const bidDecision = opts.bid != null ? { amount: opts.bid, reason: 'set manually' } : chooseBid(job, config.bid);
  if (bidDecision.amount <= 0) return refused(`no bid: ${bidDecision.reason}`);
  log(`  bid ${bidDecision.reason}`);

  const pf = await preflight(client, orgUid, job.id);
  if (!pf.clear) return refused(pf.reason ?? 'pre-flight failed');

  const chunks = loadCorpus();
  const { always, matched } = retrieve(chunks, `${job.title}\n${job.description}`);
  const instructions = await extractInstructions(job.description);
  if (instructions.agent_directed.length) {
    return refused(`posting addresses a model: ${instructions.agent_directed.join('; ')}`);
  }

  const evidence = render(always, matched);
  const letter = await composeLetter({
    title: job.title,
    posting: job.description,
    budget: job.budget,
    bid: bidDecision.amount,
    evidence,
    instructions,
  });

  const issues = verifyLetter(letter, instructions);
  if (issues.length) return refused(issues.map((i) => `${i.check}: ${i.detail}`).join('; '));
  log(`  letter ${letter.length} chars, verified`);

  // Only Upwork's own structured questions may be answered; prose questions are
  // answered inside the letter, which is where the client reads them.
  const answers = job.screeningQuestions.length
    ? await answerScreeningQuestions({
        questions: job.screeningQuestions,
        posting: job.description,
        evidence,
      })
    : [];
  if (answers.length) log(`  answered ${answers.length} screening questions`);

  const preview = await createProposal(client, orgUid, {
    job_reference: job.id,
    cover_letter: letter,
    charged_amount: bidDecision.amount,
    ...(answers.length ? { answers } : {}),
  });

  const boost = decideBoost(preview.boost, preview.connects_cost ?? 0, {
    maxConnects: config.screen.maxBoostConnects ?? 10,
    reserve: config.screen.connectsReserve,
  });
  log(`  draft ${preview.draft_id} · ${preview.connects_cost} connects · boost ${boost.connects} (${boost.reason})`);

  const chunkIds = [...always.map((c) => c.id), ...matched.map((m) => m.chunk.id)];
  const common = {
    jobId: job.id,
    draftId: preview.draft_id,
    coverLetter: letter,
    bid: bidDecision.amount,
    connectsCost: preview.connects_cost ?? null,
    boost: boost.connects,
    chunks: chunkIds,
  };

  if (!opts.live) {
    recordProposal({ ...common, proposalId: null, dryRun: true });
    return {
      outcome: 'dry_run',
      letter,
      bid: bidDecision.amount,
      connectsCost: preview.connects_cost ?? undefined,
      boost: boost.connects,
      chunks: chunkIds,
    };
  }

  const proposalId = await confirmProposal(client, orgUid, preview.draft_id);
  recordProposal({ ...common, proposalId, dryRun: false });
  setState(job.id, 'submitted');

  return {
    outcome: 'submitted',
    proposalId,
    letter,
    bid: bidDecision.amount,
    connectsCost: preview.connects_cost ?? undefined,
    boost: boost.connects,
    chunks: chunkIds,
  };
}
