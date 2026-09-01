import { matchSkills } from '../score/score.js';

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
  /** Hours logged on Upwork. Fixed-price work accrues none, so this is a real floor. */
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
  /** Hourly postings carry no project budget — search reports 0.0 for them. */
  jobType: 'fixed' | 'hourly' | null;
  budget: number | null;
  /** Client's stated hourly range, from hourlyContractTerms. */
  hourlyMin: number | null;
  hourlyMax: number | null;
  /**
   * True when proposalCount was inferred rather than reported. Upwork omits
   * proposal_count from search results when it is zero, so an absent field on
   * a posting minutes old means an empty pool — the best signal available, not
   * a missing one. Never inferred for an older posting, where absence is
   * genuinely unknown.
   */
  proposalCountInferred: boolean;
  /**
   * Upwork's own structured screening questions. Distinct from questions the
   * extraction pass finds in the description prose: `answers` may only be sent
   * to create when these exist, because Upwork will not accept answers to
   * questions it does not have.
   */
  screeningQuestions: string[];
  /** Upwork's own skill tags for the posting. Far more precise than prose. */
  skillTags: string[];
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
  /** Lowest hourly rate worth bidding, in dollars. */
  minHourlyRate: number;
  /** Hours logged on Upwork. Zero while the account is fixed-price only. */
  hoursWorked: number;
  /** FR-9: submissions allowed in a rolling 24 hours. */
  maxPerDay?: number;
  /** Ceiling on a boost bid, whatever the server recommends. */
  maxBoostConnects?: number;
  /** Tools and topics the operator can evidence. */
  skills?: string[];
  /** How many must appear before a posting counts as relevant at all. */
  minSkillMatches?: number;
}

export const DEFAULT_SCREEN_CONFIG: ScreenConfig = {
  maxAgeMinutes: 45,
  maxProposals: 20,
  connectsReserve: 30,
  minClientSpend: 1,
  minClientFeedbackCount: 1,
  maxDeliverablesPer100: 1.5,
  minHourlyRate: 15,
  hoursWorked: 0,
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
  const pq = job.preferredQualifications;
  const jss = pq.min_job_success_score ?? 0;
  const earnings = pq.min_earnings ?? 'Any';
  const hoursRequired = pq.min_hours_worked ?? 0;
  const risingTalent = pq.rising_talent ?? false;

  // Every one of these is a floor the account cannot clear yet. min_hours_worked
  // is the easiest to miss: fixed-price contracts log no hours at all, so an
  // account can be busy and still read as zero.
  const unmet = [
    jss !== 0 && `JSS ${jss}`,
    earnings !== 'Any' && `earnings ${earnings}`,
    hoursRequired > config.hoursWorked && `${hoursRequired}h worked`,
    risingTalent && 'Rising Talent badge',
  ].filter((x): x is string => Boolean(x));

  add(
    'eligible',
    unmet.length === 0,
    unmet.length ? `client requires ${unmet.join(', ')}` : 'no qualification floors',
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

  // --- relevance. A gate, not a weight.
  //
  // Every other gate asks whether a posting is winnable; none asked whether it
  // is ours. A live "Full-Time Sales Representative" posting — cold calling,
  // high-ticket closing — cleared all of them and scored 76.8, the highest of
  // the day, on an empty pool and a paying client alone. Specificity is 15% of
  // the score, so zero relevance still reaches the high seventies. Scoring
  // ranks candidates; it cannot be what decides whether something is a
  // candidate.
  const skills = config.skills ?? [];
  const required = config.minSkillMatches ?? 1;
  if (skills.length > 0) {
    // Match the TITLE and Upwork's own skill tags, never the description.
    // Prose is recall, not precision: the sales posting that surfaced this
    // mentioned GoHighLevel once in passing, which was enough to clear a
    // description-wide match while its actual tags read B2B Marketing,
    // High-Ticket Closing, Sales and Outbound Sales.
    const hits = matchSkills(job.title, job.skillTags.join(' '), skills);
    add(
      'relevant',
      hits.length >= required,
      hits.length
        ? `title/tags match ${hits.slice(0, 5).join(', ')}`
        : `title and tags match nothing we do (tags: ${job.skillTags.slice(0, 5).join(', ') || 'none'})`,
    );
  }

  // --- pool size and freshness.
  const pool = job.proposalCount;
  add(
    'pool_small',
    pool !== null && pool <= config.maxProposals,
    pool === null
      ? 'proposal count unknown on a posting past the freshness window'
      : job.proposalCountInferred
        ? 'no proposals yet (count omitted on a fresh posting)'
        : `${pool} proposals`,
  );

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
  //
  // Only meaningful for fixed-price work, where an oversized scope against a
  // small budget is the trap. Hourly bills as it goes, so the same mismatch is
  // not the same risk — and hourly postings report a budget of 0, which must
  // not be read as "a fixed job with a suspiciously missing budget".
  if (job.jobType === 'hourly') {
    add('scope_fits_budget', true, 'hourly — billed as worked, gate does not apply');

    // The scope gate does not apply to hourly work, but a rate floor does:
    // without one the agent would happily bid on $3/hr postings.
    //
    // Judge on the BOTTOM of the client's range, not the top. "$10-15/hr
    // depending on experience" pays an unrated freelancer $10 — taking the
    // ceiling as the expected rate is how you end up working at the floor
    // while believing you negotiated the cap.
    const offered = job.hourlyMin ?? job.hourlyMax;
    add(
      'rate_acceptable',
      offered !== null && offered >= config.minHourlyRate,
      offered === null
        ? 'no rate stated on an hourly posting'
        : `client range starts at $${offered}/hr, floor $${config.minHourlyRate}`,
    );
  } else {
    const budget = job.budget ?? 0;
    const deliverables = countDeliverables(job.description);
    const ratio = budget > 0 ? deliverables / (budget / 100) : Infinity;
    add(
      'scope_fits_budget',
      budget > 0 && ratio <= config.maxDeliverablesPer100,
      budget > 0
        ? `~${deliverables.toFixed(1)} deliverables for $${budget} (${ratio.toFixed(2)} per $100)`
        : 'no budget stated on a fixed-price posting',
    );
  }

  return out;
}

export const passed = (outcomes: GateOutcome[]): boolean => outcomes.every((o) => o.passed);
export const failures = (outcomes: GateOutcome[]): GateOutcome[] => outcomes.filter((o) => !o.passed);
