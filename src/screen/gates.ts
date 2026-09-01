/**
 * Hard eligibility gates (requirements FR-6, FR-8, FR-13, risk 10.e).
 *
 * Pure functions over a job detail payload. No network, no database — so the
 * whole rubric is unit-testable against recorded fixtures.
 *
 * Every gate is a REJECT, not a warning. With no human reading the output an
 * advisory flag is a log line nobody sees, and the asymmetry favours caution:
 * a missed bid costs nothing, an unfinishable contract costs a blank profile
 * months.
 */

export interface ClientRecord {
  spend_total?: string | number;
  feedback_count?: number;
  feedback_score?: number;
  contracts_total?: number;
}

export interface PreferredQualifications {
  min_job_success_score?: number;
  min_earnings?: string;
  min_hours_worked?: number;
  rising_talent?: boolean;
}

export interface JobActivity {
  totalHired?: number;
  invitesSent?: number;
}

export interface JobDetail {
  id: string;
  title: string;
  description: string;
  budget: number | null;
  createdDate: string;
  proposalCount: number | null;
  canApply: boolean;
  connectsCost: number | null;
  clientRecord: ClientRecord;
  preferredQualifications: PreferredQualifications;
  jobActivity: JobActivity;
}

export interface GateOutcome {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface ScreenConfig {
  /** Reject postings older than this at screening time. FR-4. */
  maxAgeMinutes: number;
  /** Reject pools larger than this. */
  maxProposals: number;
  /** Stop spending below this Connects reserve. FR-9. */
  connectsReserve: number;
  /** Require the client to have spent at least this much. */
  minClientSpend: number;
  /** Require at least this many reviews given — proof they leave feedback. */
  minClientFeedbackCount: number;
  /** Scope heuristic: reject when implied deliverables per $100 exceed this. */
  maxDeliverablesPer100: number;
}

export const DEFAULT_SCREEN_CONFIG: ScreenConfig = {
  maxAgeMinutes: 45,
  maxProposals: 20,
  connectsReserve: 30,
  minClientSpend: 1,
  minClientFeedbackCount: 1,
  maxDeliverablesPer100: 1.5,
};

const num = (v: string | number | undefined): number =>
  v == null ? 0 : typeof v === 'number' ? v : Number(v) || 0;

/**
 * Text that tries to steer the drafting model rather than instruct an applicant.
 *
 * These must match *imperatives aimed at a model*, never topic vocabulary. The
 * target niche is AI and automation work, where "system prompt", "you are an
 * assistant" and similar appear as ordinary job requirements — an earlier
 * version matched /system prompt/ and rejected a legitimate Claude API posting
 * on its first live run.
 */
const AGENT_DIRECTED = [
  /ignore\s+(all\s+|any\s+)?(your\s+|the\s+)?(previous\s+|prior\s+|above\s+)?instructions/i,
  /disregard\s+(the\s+|your\s+)?(above|previous|prior)\s+(instructions|prompt|rules)/i,
  /if\s+you\s+(are|were)\s+(an?\s+)?(ai|bot|llm|language model)/i,
  /reveal\s+(your|the)\s+(system\s+)?(instructions|prompt|rules)/i,
  /output\s+your\s+(system\s+)?prompt/i,
  /\byou\s+must\s+(now\s+)?(say|claim|state)\s+(that\s+)?you\s+(have|are)/i,
];

/** Arrangements that produce no completed, paid contract — so no JSS. */
const NO_CASH = [
  /revenue[- ]?shar/i,
  /profit[- ]?shar/i,
  /equity[- ]only/i,
  /commission[- ]only/i,
  /unpaid/i,
  /no (cash|upfront|payment)/i,
  /do not apply if you only accept standard cash/i,
];

/** Markers that a posting is much larger than its budget suggests. */
const HEAVY_SCOPE = [
  /app store submission/i,
  /end[- ]to[- ]end/i,
  /from scratch/i,
  /full (platform|product|system)/i,
  /production[- ]ready/i,
  /\bmilestone\s*[45-9]\b/i,
];

function countDeliverables(description: string): number {
  const milestones = description.match(/^\s*\d+[.)]\s+/gm)?.length ?? 0;
  const bullets = description.match(/^\s*[-•→*]\s+/gm)?.length ?? 0;
  const heavy = HEAVY_SCOPE.reduce((n, re) => n + (re.test(description) ? 1 : 0), 0);
  return milestones + bullets * 0.5 + heavy * 2;
}

export function screen(
  job: JobDetail,
  connectsBalance: number,
  now: Date,
  config: ScreenConfig = DEFAULT_SCREEN_CONFIG,
): GateOutcome[] {
  const out: GateOutcome[] = [];
  const add = (gate: string, passed: boolean, detail: string) => out.push({ gate, passed, detail });

  // --- FR-13: anything aimed at the model, not the applicant, is not screened further.
  const injection = AGENT_DIRECTED.find((re) => re.test(job.description));
  add(
    'no_agent_directed_text',
    !injection,
    injection ? `posting contains text addressed to an AI: ${injection.source}` : 'clean',
  );

  // --- eligibility: the operator has no JSS, so any floor is unwinnable.
  const jss = job.preferredQualifications.min_job_success_score ?? 0;
  const earnings = job.preferredQualifications.min_earnings ?? 'Any';
  add(
    'eligible',
    jss === 0 && earnings === 'Any',
    jss !== 0 || earnings !== 'Any'
      ? `client requires JSS ${jss} / earnings ${earnings}`
      : 'no JSS or earnings floor',
  );

  // --- the server's own verdict.
  add('can_apply', job.canApply, job.canApply ? 'yes' : 'server says no');

  // --- liveness: already hired means the slot is likely gone.
  const hired = job.jobActivity.totalHired ?? 0;
  add('not_yet_hired', hired === 0, hired === 0 ? 'nobody hired' : `${hired} already hired`);

  // --- the client must actually pay, and must actually leave feedback.
  const spend = num(job.clientRecord.spend_total);
  add(
    'client_pays',
    spend >= config.minClientSpend,
    `lifetime spend $${spend}`,
  );
  const feedback = job.clientRecord.feedback_count ?? 0;
  add(
    'client_leaves_feedback',
    feedback >= config.minClientFeedbackCount,
    `${feedback} reviews given`,
  );

  // --- no cash, no closed contract, no JSS.
  const noCash = NO_CASH.find((re) => re.test(job.description));
  add('paid_in_cash', !noCash, noCash ? `matches ${noCash.source}` : 'cash contract');

  // --- pool size and freshness.
  const pool = job.proposalCount ?? 0;
  add('pool_small', pool <= config.maxProposals, `${pool} proposals`);

  const ageMinutes = (now.getTime() - new Date(job.createdDate).getTime()) / 60000;
  add(
    'fresh',
    ageMinutes <= config.maxAgeMinutes,
    `${Math.round(ageMinutes)} minutes old`,
  );

  // --- affordability. FR-9.
  const cost = job.connectsCost ?? 0;
  add(
    'affordable',
    cost > 0 && connectsBalance - cost >= config.connectsReserve,
    `costs ${cost}, balance ${connectsBalance}, reserve ${config.connectsReserve}`,
  );

  // --- risk 10.e: scope must be plausible for the budget. Hard reject.
  const budget = job.budget ?? 0;
  const deliverables = countDeliverables(job.description);
  const ratio = budget > 0 ? deliverables / (budget / 100) : Infinity;
  add(
    'scope_fits_budget',
    budget > 0 && ratio <= config.maxDeliverablesPer100,
    budget > 0
      ? `~${deliverables.toFixed(1)} deliverables for $${budget} (${ratio.toFixed(2)} per $100)`
      : 'no budget stated',
  );

  return out;
}

export const passed = (outcomes: GateOutcome[]): boolean => outcomes.every((o) => o.passed);
export const failures = (outcomes: GateOutcome[]): GateOutcome[] => outcomes.filter((o) => !o.passed);
