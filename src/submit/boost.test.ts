import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBoost, type BoostBlock, type BoostConfig } from './boost.js';

const config: BoostConfig = { maxConnects: 10, reserve: 30 };
const base: BoostBlock = {
  available: true,
  current_top_bids: [7, 6, 5, 3],
  current_top_bids_available: true,
  recommendation: 'boost',
  recommended_connects: 4,
  your_balance: 167,
};

test('a cheap slot in a thin auction is taken', () => {
  // The real numbers from a live preview: top bids [7,6,5,3], recommended 4.
  const d = decideBoost(base, 13, config);
  assert.equal(d.connects, 4);
  assert.match(d.reason, /7, 6, 5, 3/);
});

test('boosting is skipped when unavailable', () => {
  const d = decideBoost({ available: false, reason: 'unmet preferred qualifications' }, 13, config);
  assert.equal(d.connects, 0);
  assert.match(d.reason, /unmet preferred/);
});

test('a server recommendation to skip is obeyed', () => {
  assert.equal(decideBoost({ ...base, recommendation: 'skip' }, 13, config).connects, 0);
});

test('unknown competing bids are not treated as no bids', () => {
  // 51 Connects went into a 120-proposal pool in August, blind, and lost.
  const d = decideBoost({ ...base, current_top_bids_available: false }, 13, config);
  assert.equal(d.connects, 0);
  assert.match(d.reason, /not bidding blind/);
});

test('a recommendation above the ceiling is refused', () => {
  const d = decideBoost({ ...base, recommended_connects: 51 }, 13, config);
  assert.equal(d.connects, 0);
  assert.match(d.reason, /exceeds the ceiling/);
});

test('a bid that would breach the Connects reserve is refused', () => {
  const d = decideBoost({ ...base, recommended_connects: 8, your_balance: 45 }, 13, config);
  assert.equal(d.connects, 0);
  assert.match(d.reason, /reserve/);
});

test('an empty auction still takes the recommended slot', () => {
  const d = decideBoost({ ...base, current_top_bids: [] }, 13, config);
  assert.equal(d.connects, 4);
  assert.match(d.reason, /nobody has boosted/);
});

test('a missing boost block is a skip, never a guess', () => {
  assert.equal(decideBoost(undefined, 13, config).connects, 0);
});
