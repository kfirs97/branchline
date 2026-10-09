import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIAL_DAYS, trialStatus } from '../src/trial';

const DAY = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 9, 9);

test('trial is active for the first days and reports days left', () => {
  assert.deepEqual(trialStatus(start, start), { active: true, msLeft: TRIAL_DAYS * DAY, daysLeft: TRIAL_DAYS });
  const mid = trialStatus(start, start + 2.5 * DAY);
  assert.equal(mid.active, true);
  assert.equal(mid.daysLeft, 5);
  assert.equal(mid.msLeft, (TRIAL_DAYS - 2.5) * DAY);
});

test('trial ends exactly after TRIAL_DAYS and stays ended', () => {
  assert.equal(trialStatus(start, start + TRIAL_DAYS * DAY - 1).active, true);
  for (const t of [start + TRIAL_DAYS * DAY, start + 365 * DAY]) assert.deepEqual(trialStatus(start, t), { active: false, msLeft: 0, daysLeft: 0 });
});

test('a clock set backwards does not extend the trial', () => {
  assert.equal(trialStatus(start, start - 30 * DAY).msLeft, TRIAL_DAYS * DAY);
});
