/** Pro trial timing. Kept free of the vscode API so it can be unit tested. */

export const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialStatus {
  active: boolean;
  msLeft: number;
  daysLeft: number;
}

/** Trial status for a trial that started at `startedAt` (epoch ms). A clock set backwards doesn't extend it. */
export function trialStatus(startedAt: number, now: number = Date.now()): TrialStatus {
  const elapsed = Math.max(0, now - startedAt);
  const msLeft = Math.max(0, TRIAL_DAYS * DAY_MS - elapsed);
  return { active: msLeft > 0, msLeft, daysLeft: Math.ceil(msLeft / DAY_MS) };
}
