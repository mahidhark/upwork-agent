/**
 * Choosing what to bid, without a human in the loop.
 *
 * The current strategy is to bid down deliberately to win the first closed
 * contracts and earn a Job Success Score, so this aims to be chosen rather than
 * to maximise the invoice. It never bids below the operator's floor — winning
 * work that is not worth doing is not winning.
 *
 * Pure function. No network.
 */
import type { JobDetail } from '../screen/gates.js';

export interface BidConfig {
  /** Never bid below this hourly rate. */
  minHourlyRate: number;
  /**
   * Where to sit inside the client's stated hourly range. 0 is their floor,
   * 1 their ceiling. Low while building a score.
   */
  hourlyRangePosition: number;
  /** Fraction of a fixed-price budget to bid. */
  fixedBudgetFraction: number;
}

export const DEFAULT_BID_CONFIG: BidConfig = {
  minHourlyRate: 15,
  hourlyRangePosition: 0.25,
  fixedBudgetFraction: 0.9,
};

export interface BidDecision {
  amount: number;
  reason: string;
}

export function chooseBid(job: JobDetail, config: BidConfig = DEFAULT_BID_CONFIG): BidDecision {
  if (job.jobType === 'hourly') {
    const low = job.hourlyMin;
    const high = job.hourlyMax ?? low;
    if (low == null || high == null) {
      return { amount: 0, reason: 'no hourly range stated — cannot choose a bid' };
    }

    const positioned = low + (high - low) * config.hourlyRangePosition;
    const amount = Math.max(config.minHourlyRate, Math.round(positioned));

    // Bidding the floor when the client's whole range sits beneath it is not a
    // bid, it is an argument. Refuse and let the gate reject the posting.
    if (amount > high) {
      return {
        amount: 0,
        reason: `floor $${config.minHourlyRate} exceeds the client's ceiling of $${high}`,
      };
    }
    return {
      amount,
      reason: `$${amount}/hr — ${Math.round(config.hourlyRangePosition * 100)}% into the client's $${low}-${high} range`,
    };
  }

  const budget = job.budget;
  if (budget == null || budget <= 0) {
    return { amount: 0, reason: 'no fixed budget stated — cannot choose a bid' };
  }
  // Slightly under the stated budget: visible as a considered number rather
  // than a reflexive match, and it leaves the client something.
  const amount = Math.max(1, Math.round(budget * config.fixedBudgetFraction));
  return {
    amount,
    reason: `$${amount} — ${Math.round(config.fixedBudgetFraction * 100)}% of the stated $${budget}`,
  };
}
