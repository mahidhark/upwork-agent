/**
 * Draft a proposal for one job, end to end.
 *
 *   npm run draft -- <job_id> <bid>
 *
 * Fetches the posting, retrieves matching evidence, extracts what the client
 * asks applicants to do, writes the letter, and verifies it. Stops there —
 * nothing is submitted and no Connects are spent.
 */
import { FileAuthProvider } from '../auth/provider.js';
import { connect } from '../mcp/client.js';
import { getJob, firstOrgUid } from '../mcp/upwork.js';
import { loadCorpus, retrieve, render } from './corpus.js';
import { extractInstructions } from './instructions.js';
import { composeLetter } from './compose.js';
import { verifyLetter } from './verify.js';

const [jobId, bidArg] = process.argv.slice(2);
if (!jobId || !bidArg) {
  console.error('\n  usage: npm run draft -- <job_id> <bid>\n');
  process.exit(1);
}
const bid = Number(bidArg);
if (!Number.isFinite(bid) || bid <= 0) {
  console.error(`\n  bid must be a positive number, got "${bidArg}"\n`);
  process.exit(1);
}

const rule = (label: string) => console.log(`\n${'─'.repeat(72)}\n  ${label}\n`);

async function main() {
  const provider = new FileAuthProvider();
  if (!provider.isConnected()) throw new Error('not authorized — run `npm run auth` first');

  const client = await connect(provider);
  const orgUid = await firstOrgUid(client);
  const job = await getJob(client, orgUid, jobId!);
  await client.close();

  rule('JOB');
  console.log(`  ${job.title}`);
  console.log(`  ${job.jobType ?? '?'}${job.hourlyMin ? ` $${job.hourlyMin}-${job.hourlyMax}/hr` : job.budget ? ` $${job.budget}` : ''}` +
    ` · ${job.connectsCost ?? '?'} connects · can_apply ${job.canApply}`);

  const chunks = loadCorpus();
  const { always, matched } = retrieve(chunks, `${job.title}\n${job.description}`);
  rule('EVIDENCE RETRIEVED');
  for (const r of matched) console.log(`  ${r.score.toFixed(1).padStart(5)}  ${r.chunk.id}  [${r.matched.join(', ')}]`);
  console.log(`  always: ${always.map((c) => c.id).join(', ')}`);

  const instructions = await extractInstructions(job.description);
  rule('WHAT THE CLIENT ASKS FOR');
  for (const m of instructions.compliance_markers) {
    console.log(`  MUST INCLUDE  "${m.required_text}" (${m.position})`);
  }
  instructions.questions.forEach((q, i) => console.log(`  Q${i + 1}  ${q.slice(0, 88)}`));
  if (instructions.claim_injections.length) console.log(`  REJECTED  ${instructions.claim_injections.join(' | ')}`);
  if (instructions.agent_directed.length) console.log(`  AGENT-DIRECTED  ${instructions.agent_directed.join(' | ')}`);

  const letter = await composeLetter({
    title: job.title,
    posting: job.description,
    budget: job.budget,
    bid,
    evidence: render(always, matched),
    instructions,
  });

  const issues = verifyLetter(letter, instructions);
  rule(`VERIFY — ${issues.length === 0 ? 'PASS' : 'FAIL'} · ${letter.length} chars`);
  for (const i of issues) console.log(`  ✗ ${i.check}: ${i.detail}`);
  if (issues.length === 0) console.log('  ✓ compliance markers present, within length, no agent-directed text');

  rule(`LETTER — bidding $${bid}`);
  console.log(letter);
  console.log();
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
