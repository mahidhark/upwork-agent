/**
 * Apply to one job, end to end (requirements FR-10, FR-15 to FR-19).
 *
 *   npm run apply -- <job_id> <bid>          dry run — drafts and records, sends nothing
 *   npm run apply -- <job_id> <bid> --live   actually submits, spends Connects
 *
 * Dry run is the default and stays the default (NFR-7). Every guard here is a
 * refusal rather than a warning: with nobody reading the letter before it goes,
 * a warning is a log line no one sees.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { STORE_DIR } from '../config.js';
import { loadConfig } from '../search-profiles.js';
import { FileAuthProvider } from '../auth/provider.js';
import { connect } from '../mcp/client.js';
import {
  getJob,
  firstOrgUid,
  connectsBalance,
  preflight,
  createProposal,
  confirmProposal,
} from '../mcp/upwork.js';
import { screen, passed, failures } from '../screen/gates.js';
import { loadCorpus, retrieve, render } from '../draft/corpus.js';
import { extractInstructions } from '../draft/instructions.js';
import { composeLetter } from '../draft/compose.js';
import { verifyLetter } from '../draft/verify.js';
import { answerScreeningQuestions } from '../draft/answers.js';
import { decideBoost } from './boost.js';
import { recordProposal, submittedSince, setState, getJobRow } from '../store/db.js';

/** A file that stops all submission without stopping ingest. */
const KILL_SWITCH = join(STORE_DIR, 'STOP');

const [jobId, bidArg, ...flags] = process.argv.slice(2);
const live = flags.includes('--live');

if (!jobId || !bidArg) {
  console.error('\n  usage: npm run apply -- <job_id> <bid> [--live]\n');
  process.exit(1);
}
const bid = Number(bidArg);
if (!Number.isFinite(bid) || bid <= 0) {
  console.error(`\n  bid must be a positive number, got "${bidArg}"\n`);
  process.exit(1);
}

const step = (s: string) => console.log(`\n  ── ${s}`);
function refuse(why: string): never {
  console.error(`\n  REFUSED — ${why}\n`);
  process.exit(2);
}

async function main() {
  const config = loadConfig();

  if (live && existsSync(KILL_SWITCH)) {
    refuse(`kill switch present at ${KILL_SWITCH} — remove it to allow submission`);
  }

  // FR-9 daily cap, enforced before anything else spends a call.
  if (live) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const sent = submittedSince(since);
    const cap = config.screen.maxPerDay ?? 3;
    if (sent >= cap) refuse(`${sent} proposals already submitted in 24h, cap is ${cap}`);
    console.log(`\n  ${sent}/${cap} proposals submitted in the last 24h`);
  }

  const provider = new FileAuthProvider();
  if (!provider.isConnected()) refuse('not authorized — run `npm run auth` first');

  const client = await connect(provider);
  const orgUid = await firstOrgUid(client);

  step('fetching');
  const job = await getJob(client, orgUid, jobId!);
  console.log(`  ${job.title}`);

  step('re-screening');

  // find_jobs get returns neither the posting date nor the pool size — it
  // stubs the date as "now" and leaves the count null. Both come from search,
  // captured at ingest, so the re-screen reads them from the database. A job
  // we never screened cannot be verified at all, and is refused rather than
  // submitted against unknowns.
  const row = getJobRow(jobId!);
  if (!row) refuse('this job is not in the database — only screened jobs can be applied to');
  job.createdDate = row.created_date;
  job.proposalCount = row.proposal_count;
  job.proposalCountInferred = row.proposal_count === 0;

  const balance = (await connectsBalance(client, orgUid)).connectsBalance;
  const outcomes = screen(job, balance, new Date(), config.screen);
  // The gates ran at ingest, but a posting can be filled or edited since. Any
  // gate now failing is a refusal — never submit against a stale verdict.
  if (!passed(outcomes)) {
    refuse(`gates now fail: ${failures(outcomes).map((f) => `${f.gate} (${f.detail})`).join('; ')}`);
  }
  console.log(`  all ${outcomes.length} gates pass · balance ${balance}`);

  step('pre-flight');
  const pf = await preflight(client, orgUid, jobId!);
  if (!pf.clear) refuse(pf.reason ?? 'pre-flight failed');
  console.log('  no invitation, no existing proposal');

  step('drafting');
  const chunks = loadCorpus();
  const { always, matched } = retrieve(chunks, `${job.title}\n${job.description}`);
  const instructions = await extractInstructions(job.description);
  if (instructions.agent_directed.length) {
    refuse(`posting contains text aimed at a model: ${instructions.agent_directed.join('; ')}`);
  }
  const letter = await composeLetter({
    title: job.title,
    posting: job.description,
    budget: job.budget,
    bid,
    evidence: render(always, matched),
    instructions,
  });

  step('verifying');
  const issues = verifyLetter(letter, instructions);
  if (issues.length) {
    refuse(issues.map((i) => `${i.check}: ${i.detail}`).join('; '));
  }
  console.log(`  ${letter.length} chars · markers present · grounded in ${matched.length + always.length} chunks`);

  // Only Upwork's OWN screening_questions may be answered. Questions the
  // extraction pass found in the description prose are answered inside the
  // letter instead — Upwork will not accept answers to questions it does not
  // have, and a stubbed "see cover letter" is the first thing a client reads.
  let answers: Array<{ question: string; answer: string }> = [];
  if (job.screeningQuestions.length) {
    step(`answering ${job.screeningQuestions.length} screening questions`);
    answers = await answerScreeningQuestions({
      questions: job.screeningQuestions,
      posting: job.description,
      evidence: render(always, matched),
    });
    for (const a of answers) console.log(`  Q ${a.question.slice(0, 60)}\n  A ${a.answer.slice(0, 90)}`);
  }

  step('creating draft');
  const preview = await createProposal(client, orgUid, {
    job_reference: jobId!,
    cover_letter: letter,
    charged_amount: bid,
    ...(answers.length ? { answers } : {}),
  });
  console.log(`  draft ${preview.draft_id} · ${preview.connects_cost} connects · can_apply ${preview.can_apply}`);

  const boost = decideBoost(preview.boost, preview.connects_cost ?? 0, {
    maxConnects: config.screen.maxBoostConnects ?? 10,
    reserve: config.screen.connectsReserve,
  });
  console.log(`  boost: ${boost.connects} — ${boost.reason}`);

  const chunkIds = [...always.map((c) => c.id), ...matched.map((m) => m.chunk.id)];

  if (!live) {
    recordProposal({
      jobId: jobId!, draftId: preview.draft_id, proposalId: null,
      coverLetter: letter, bid, connectsCost: preview.connects_cost ?? null,
      boost: boost.connects, chunks: chunkIds, dryRun: true,
    });
    await client.close();
    console.log(`\n  DRY RUN — nothing submitted, no Connects spent.`);
    console.log(`  Re-run with --live to send.\n`);
    console.log(letter);
    console.log();
    return;
  }

  step('submitting');
  const proposalId = await confirmProposal(client, orgUid, preview.draft_id);
  recordProposal({
    jobId: jobId!, draftId: preview.draft_id, proposalId,
    coverLetter: letter, bid, connectsCost: preview.connects_cost ?? null,
    boost: boost.connects, chunks: chunkIds, dryRun: false,
  });
  setState(jobId!, 'submitted');
  await client.close();

  console.log(`\n  SUBMITTED — proposal ${proposalId}, ${preview.connects_cost} connects\n`);
}

main().catch((err) => {
  console.error(`\n  FAILED — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
