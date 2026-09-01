/**
 * Boost decision (requirements FR-16).
 *
 * Boosting is a Connects BID for a top slot on the client's list, charged only
 * if the proposal finishes top-4 or the client engages it before the auction
 * closes. It is a create-time parameter: once a proposal is submitted the
 * opportunity is gone for that posting, so the decision belongs here.
 *
 * Pure function over the create preview. No network.
 */

export interface BoostBlock {
  available?: boolean;
  reason?: string;
  current_top_bids?: number[];
  current_top_bids_available?: boolean;
  recommendation?: string;
  recommended_connects?: number;
  your_balance?: number;
}

export interface BoostConfig {
  /** Never bid more than this, whatever the server recommends. */
  maxConnects: number;
  /** Keep at least this many Connects unspent. */
  reserve: number;
}

export interface BoostDecision {
  connects: number;
  reason: string;
}

export function decideBoost(
  boost: BoostBlock | undefined,
  applicationCost: number,
  config: BoostConfig,
): BoostDecision {
  if (!boost || boost.available !== true) {
    return { connects: 0, reason: boost?.reason ?? 'boosting not available on this posting' };
  }
  if (boost.recommendation === 'skip') {
    return { connects: 0, reason: 'server recommends skipping' };
  }

  // Unknown bids are NOT the same as no bids. Bidding blind is how 51 Connects
  // went into a 120-proposal pool in August and lost.
  if (boost.current_top_bids_available === false) {
    return { connects: 0, reason: 'competing bids could not be read — not bidding blind' };
  }

  const recommended = boost.recommended_connects ?? 0;
  if (recommended <= 0) {
    return { connects: 0, reason: 'no recommended bid' };
  }
  if (recommended > config.maxConnects) {
    return {
      connects: 0,
      reason: `recommended ${recommended} exceeds the ceiling of ${config.maxConnects}`,
    };
  }

  const balance = boost.your_balance ?? 0;
  const affordable = balance - applicationCost - config.reserve;
  if (recommended > affordable) {
    return {
      connects: 0,
      reason: `${recommended} would breach the reserve (balance ${balance}, application ${applicationCost}, reserve ${config.reserve})`,
    };
  }

  const bids = boost.current_top_bids ?? [];
  return {
    connects: recommended,
    reason: bids.length
      ? `top bids are [${bids.join(', ')}] — ${recommended} takes a slot`
      : `nobody has boosted — ${recommended} takes a slot`,
  };
}
