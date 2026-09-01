/**
 * Apply to one job from the command line.
 *
 *   npm run apply -- <job_id> [bid] [--live]
 *
 * The bid is chosen automatically unless given. Dry run unless --live.
 * All the logic lives in run.ts, shared with the poller, so the CLI and the
 * automatic path cannot drift apart.
 */
import { loadConfig } from '../search-profiles.js';
import { FileAuthProvider } from '../auth/provider.js';
import { connect } from '../mcp/client.js';
import { getJob, firstOrgUid, connectsBalance } from '../mcp/upwork.js';
import { getJobRow } from '../store/db.js';
import { applyToJob } from './run.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const [jobId, bidArg] = args.filter((a) => !a.startsWith('--'));

if (!jobId) {
  console.error('\n  usage: npm run apply -- <job_id> [bid] [--live]\n');
  process.exit(1);
}

async function main() {
  const config = loadConfig();
  const provider = new FileAuthProvider();
  if (!provider.isConnected()) throw new Error('not authorized — run `npm run auth` first');

  const client = await connect(provider);
  const orgUid = await firstOrgUid(client);
  const job = await getJob(client, orgUid, jobId!);

  // get returns neither the posting date nor the pool size; both come from
  // search at ingest, so a job we never screened cannot be verified.
  const row = getJobRow(jobId!);
  if (!row) {
    await client.close();
    console.error('\n  REFUSED — this job is not in the database; only screened jobs can be applied to\n');
    process.exit(2);
  }
  job.createdDate = row.created_date;
  job.proposalCount = row.proposal_count;
  job.proposalCountInferred = row.proposal_count === 0;
  try {
    job.skillTags = (JSON.parse(row.raw) as { skills?: string[] }).skills ?? [];
  } catch {
    job.skillTags = [];
  }

  const balance = (await connectsBalance(client, orgUid)).connectsBalance;
  console.log(`\n  ${job.title}\n  balance ${balance} connects${live ? '' : '  ·  DRY RUN'}\n`);

  const result = await applyToJob(
    client, orgUid, job, balance, config,
    { live, ...(bidArg ? { bid: Number(bidArg) } : {}) },
    (l) => console.log(l),
  );
  await client.close();

  if (result.outcome === 'refused') {
    console.error(`\n  REFUSED — ${result.reason}\n`);
    process.exit(2);
  }
  if (result.outcome === 'submitted') {
    console.log(`\n  SUBMITTED — ${result.proposalId} · $${result.bid} · ${result.connectsCost} connects\n`);
  } else {
    console.log(`\n  DRY RUN — nothing sent. $${result.bid}, would cost ${result.connectsCost} connects.\n`);
    console.log(result.letter);
    console.log();
  }
}

main().catch((err) => {
  console.error(`\n  FAILED — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
