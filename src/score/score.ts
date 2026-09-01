/**
 * Fit scoring (requirements FR-7).
 *
 * Ranks postings that already cleared every hard gate. Gates decide *whether*
 * to bid; scoring decides *what to bid on first* when more postings qualify
 * than the Connects budget can cover — which is the normal case, since the
 * binding constraint is Connects rather than time.
 *
 * The dominant signal is competitive density, not job attractiveness. Seven
 * proposals submitted in August went into pools of 93–473 and drew a 3.4%
 * aggregate open rate; position in the list is a function of elapsed time and
 * pool size, and nothing in the letter compensates for being thirtieth.
 *
 * Pure functions. No network, no database.
 */
import type { JobDetail } from '../screen/gates.js';

export interface ScoreWeights {
  pool: number;
  freshness: number;
  specificity: number;
  clientFeedback: number;
  clientSpend: number;
  budgetFit: number;
}

export interface ScoreConfig {
  weights: ScoreWeights;
  /** Pool size at which the pool signal reaches zero. */
  poolFloor: number;
  /** Age in minutes at which the freshness signal reaches zero. */
  freshnessFloorMinutes: number;
  /** Reviews given by the client for full marks — proof they close and rate. */
  feedbackTarget: number;
  /** Client lifetime spend, in dollars, for full marks. */
  spendTarget: number;
  /** Budget band that suits the current strategy, for fixed-price work. */
  budgetSweetSpot: { min: number; max: number };
  /** Equivalent band for hourly work, in dollars per hour. */
  hourlySweetSpot: { min: number; max: number };
  /** Tools and topics the operator can evidence. Matching earns specificity. */
  skills: string[];
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  weights: {
    pool: 0.35,
    freshness: 0.25,
    specificity: 0.15,
    clientFeedback: 0.1,
    clientSpend: 0.05,
    budgetFit: 0.1,
  },
  poolFloor: 20,
  freshnessFloorMinutes: 45,
  feedbackTarget: 10,
  spendTarget: 10000,
  budgetSweetSpot: { min: 100, max: 600 },
  hourlySweetSpot: { min: 20, max: 60 },
  skills: [],
};

export interface ScoreBreakdown {
  total: number;
  components: Record<keyof ScoreWeights, number>;
  matchedSkills: string[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const num = (v: string | number | undefined): number =>
  v == null ? 0 : typeof v === 'number' ? v : Number(v) || 0;

/**
 * Budget fit is flat inside the band and tapers outside it, rather than simply
 * preferring more money. While the goal is closed contracts rather than
 * revenue, a job far above the band is usually one this account cannot win and
 * a job far below is not worth the Connects.
 */
function budgetFit(budget: number | null, band: { min: number; max: number }): number {
  if (budget == null || budget <= 0) return 0;
  if (budget >= band.min && budget <= band.max) return 1;
  const distance = budget < band.min ? band.min - budget : budget - band.max;
  const scale = budget < band.min ? band.min : band.max;
  return clamp01(1 - distance / scale);
}

/**
 * Specificity: a posting naming tools the operator can evidence is both a
 * better match and, empirically, a thinner pool. On one search page a posting
 * titled "Automation Expert Needed" carried 36 proposals while
 * "Zoho Team Inbox Expert — Zoho Mail Migration, 98 Templates" carried 8 at
 * eleven hours old.
 */
function specificity(job: JobDetail, skills: string[]): { value: number; matched: string[] } {
  if (skills.length === 0) return { value: 0, matched: [] };
  const haystack = `${job.title}\n${job.description}`.toLowerCase();
  const matched = skills.filter((s) => haystack.includes(s.toLowerCase()));
  // Three distinct matches is a strong signal; more adds little.
  return { value: clamp01(matched.length / 3), matched };
}

export function scoreJob(
  job: JobDetail,
  now: Date,
  config: ScoreConfig = DEFAULT_SCORE_CONFIG,
): ScoreBreakdown {
  const pool = job.proposalCount ?? config.poolFloor;
  const ageMinutes = (now.getTime() - new Date(job.createdDate).getTime()) / 60000;
  const spec = specificity(job, config.skills);

  const components: Record<keyof ScoreWeights, number> = {
    pool: clamp01(1 - pool / config.poolFloor),
    freshness: clamp01(1 - ageMinutes / config.freshnessFloorMinutes),
    specificity: spec.value,
    clientFeedback: clamp01((job.clientRecord.feedback_count ?? 0) / config.feedbackTarget),
    clientSpend: clamp01(
      Math.log10(num(job.clientRecord.spend_total) + 1) / Math.log10(config.spendTarget),
    ),
    // Hourly postings carry no project budget, so judge them on the bottom of
    // the stated rate range against an hourly band. Without this every hourly
    // job scored zero here and lost a tenth of its total for being hourly.
    budgetFit:
      job.jobType === 'hourly'
        ? budgetFit(job.hourlyMin ?? job.hourlyMax, config.hourlySweetSpot)
        : budgetFit(job.budget, config.budgetSweetSpot),
  };

  let total = 0;
  for (const [key, weight] of Object.entries(config.weights) as Array<[keyof ScoreWeights, number]>) {
    total += components[key] * weight;
  }

  return { total: Math.round(total * 1000) / 10, components, matchedSkills: spec.matched };
}

/** Highest first. */
export function rank<T extends { score: ScoreBreakdown }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.score.total - a.score.total);
}
