import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBid, DEFAULT_BID_CONFIG } from './bid.js';
import type { JobDetail } from '../screen/gates.js';

const job = (over: Partial<JobDetail>): JobDetail => ({
  id: 'x', title: 'x', description: 'x',
  jobType: 'fixed', budget: 500, hourlyMin: null, hourlyMax: null,
  proposalCountInferred: false, screeningQuestions: [], skillTags: [],
  createdDate: '2026-09-01T12:00:00Z', proposalCount: 3, canApply: true,
  connectsCost: 12, clientRecord: {}, preferredQualifications: {}, jobActivity: {},
  ...over,
});

test('a fixed bid sits just under the stated budget', () => {
  const d = chooseBid(job({ jobType: 'fixed', budget: 500 }));
  assert.equal(d.amount, 450);
});

test('an hourly bid sits low in the client range while building a score', () => {
  // The real Claude Code posting: $25-50/hr.
  const d = chooseBid(job({ jobType: 'hourly', budget: null, hourlyMin: 25, hourlyMax: 50 }));
  assert.equal(d.amount, 31);
  assert.match(d.reason, /25-50/);
});

test('the hourly floor is never undercut', () => {
  const d = chooseBid(job({ jobType: 'hourly', budget: null, hourlyMin: 10, hourlyMax: 40 }));
  assert.ok(d.amount >= DEFAULT_BID_CONFIG.minHourlyRate, `got ${d.amount}`);
});

test('a range entirely below the floor produces no bid', () => {
  // Bidding the floor here is not a bid, it is an argument with the client.
  const d = chooseBid(job({ jobType: 'hourly', budget: null, hourlyMin: 5, hourlyMax: 12 }));
  assert.equal(d.amount, 0);
  assert.match(d.reason, /exceeds the client's ceiling/);
});

test('a single-point hourly rate is honoured', () => {
  const d = chooseBid(job({ jobType: 'hourly', budget: null, hourlyMin: 40, hourlyMax: 40 }));
  assert.equal(d.amount, 40);
});

test('a missing budget produces no bid, never a guess', () => {
  assert.equal(chooseBid(job({ jobType: 'fixed', budget: null })).amount, 0);
  assert.equal(chooseBid(job({ jobType: 'hourly', budget: null, hourlyMin: null, hourlyMax: null })).amount, 0);
});
