import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreJob, rank, DEFAULT_SCORE_CONFIG, type ScoreConfig } from './score.js';
import type { JobDetail } from '../screen/gates.js';

const NOW = new Date('2026-09-01T12:00:00Z');

const config: ScoreConfig = {
  ...DEFAULT_SCORE_CONFIG,
  skills: ['n8n', 'make.com', 'whatsapp', 'zapier', 'webhook', 'postgres'],
};

const job = (over: Partial<JobDetail> = {}): JobDetail => ({
  id: 'x',
  title: 'Automation work',
  description: 'Connect two systems.',
  jobType: 'fixed',
  hourlyMin: null,
  hourlyMax: null,
  proposalCountInferred: false,
  screeningQuestions: [],
  budget: 300,
  createdDate: '2026-09-01T11:50:00Z',
  proposalCount: 5,
  canApply: true,
  connectsCost: 12,
  clientRecord: { spend_total: '500', feedback_count: 5 },
  preferredQualifications: {},
  jobActivity: { totalHired: 0 },
  ...over,
});

test('a thin, fresh, well-matched posting scores high', () => {
  const s = scoreJob(
    job({
      proposalCount: 2,
      createdDate: '2026-09-01T11:57:00Z',
      title: 'n8n + WhatsApp webhook automation',
      clientRecord: { spend_total: '5000', feedback_count: 12 },
    }),
    NOW,
    config,
  );
  assert.ok(s.total > 80, `expected > 80, got ${s.total}`);
});

test('pool size dominates — a crowded pool cannot be rescued by a good client', () => {
  const thin = scoreJob(job({ proposalCount: 2 }), NOW, config);
  const crowded = scoreJob(
    job({ proposalCount: 19, clientRecord: { spend_total: '100000', feedback_count: 200 } }),
    NOW,
    config,
  );
  assert.ok(thin.total > crowded.total, `${thin.total} should beat ${crowded.total}`);
});

test('freshness decays with age', () => {
  const now = scoreJob(job({ createdDate: '2026-09-01T11:58:00Z' }), NOW, config);
  const old = scoreJob(job({ createdDate: '2026-09-01T11:20:00Z' }), NOW, config);
  assert.ok(now.components.freshness > old.components.freshness);
  assert.ok(now.total > old.total);
});

test('naming known tools earns specificity, and reports which matched', () => {
  const generic = scoreJob(job({ title: 'Automation Expert Needed' }), NOW, config);
  const named = scoreJob(
    job({ title: 'n8n and Make.com specialist', description: 'Wire a webhook into Postgres.' }),
    NOW,
    config,
  );
  assert.equal(generic.matchedSkills.length, 0);
  assert.deepEqual(named.matchedSkills.sort(), ['make.com', 'n8n', 'postgres', 'webhook'].sort());
  assert.ok(named.total > generic.total);
});

test('a client who leaves feedback outranks one who does not', () => {
  const rates = scoreJob(job({ clientRecord: { spend_total: '500', feedback_count: 12 } }), NOW, config);
  const silent = scoreJob(job({ clientRecord: { spend_total: '500', feedback_count: 0 } }), NOW, config);
  assert.ok(rates.total > silent.total);
});

test('budget fit is flat inside the band and tapers outside it', () => {
  const inside = scoreJob(job({ budget: 300 }), NOW, config);
  const alsoInside = scoreJob(job({ budget: 550 }), NOW, config);
  const far = scoreJob(job({ budget: 5000 }), NOW, config);
  assert.equal(inside.components.budgetFit, 1);
  assert.equal(alsoInside.components.budgetFit, 1);
  assert.ok(far.components.budgetFit < 0.5, `expected taper, got ${far.components.budgetFit}`);
});

test('a missing proposal count is treated as the worst case, never the best', () => {
  const unknown = scoreJob(job({ proposalCount: null }), NOW, config);
  assert.equal(unknown.components.pool, 0);
});

test('scores stay within 0 and 100', () => {
  const best = scoreJob(
    job({
      proposalCount: 0,
      createdDate: '2026-09-01T12:00:00Z',
      title: 'n8n make.com whatsapp zapier webhook postgres',
      budget: 300,
      clientRecord: { spend_total: '999999', feedback_count: 500 },
    }),
    NOW,
    config,
  );
  const worst = scoreJob(
    job({
      proposalCount: 999,
      createdDate: '2026-08-01T00:00:00Z',
      budget: null,
      clientRecord: { spend_total: '0', feedback_count: 0 },
    }),
    NOW,
    config,
  );
  assert.ok(best.total <= 100 && best.total >= 0, `best ${best.total}`);
  assert.ok(worst.total <= 100 && worst.total >= 0, `worst ${worst.total}`);
  assert.ok(best.total > worst.total);
});

test('rank orders highest first', () => {
  const items = [
    { name: 'crowded', score: scoreJob(job({ proposalCount: 18 }), NOW, config) },
    { name: 'thin', score: scoreJob(job({ proposalCount: 1 }), NOW, config) },
    { name: 'middling', score: scoreJob(job({ proposalCount: 9 }), NOW, config) },
  ];
  assert.deepEqual(rank(items).map((i) => i.name), ['thin', 'middling', 'crowded']);
});

test('the real August pools score near the floor', () => {
  // 164 proposals, hours old — the shape that produced a 3.4% open rate.
  const august = scoreJob(
    job({ proposalCount: 164, createdDate: '2026-09-01T04:00:00Z' }),
    NOW,
    config,
  );
  assert.equal(august.components.pool, 0);
  assert.equal(august.components.freshness, 0);
  assert.ok(august.total < 25, `expected < 25, got ${august.total}`);
});

test('hourly postings are scored on their rate, not penalised for having no budget', () => {
  const good = scoreJob(job({ jobType: 'hourly', budget: null, hourlyMin: 35, hourlyMax: 60 }), NOW, config);
  const poor = scoreJob(job({ jobType: 'hourly', budget: null, hourlyMin: 8, hourlyMax: 12 }), NOW, config);
  assert.equal(good.components.budgetFit, 1, 'a $35/hr posting should sit inside the band');
  assert.ok(poor.components.budgetFit < 0.7, `expected a taper, got ${poor.components.budgetFit}`);
  assert.ok(good.total > poor.total);
});

test('an hourly posting is not scored on the top of its range', () => {
  const s = scoreJob(job({ jobType: 'hourly', budget: null, hourlyMin: 10, hourlyMax: 100 }), NOW, config);
  assert.ok(s.components.budgetFit < 1, 'the $10 floor should decide, not the $100 ceiling');
});
