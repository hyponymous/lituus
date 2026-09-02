/**
 * The handful of choices that outlive a tab.
 *
 * Only *preferences* live here — never session progress. A reload still loses
 * the guesses (PRD §4.6); what it should not lose is a decision the user
 * already made about how the tool behaves, and re-ticking the scoring box
 * every visit is the one that grates.
 *
 * Every access is guarded: `localStorage` throws outright in a browser set to
 * block site data, and setting throws when the quota is full. A preference is
 * not worth failing a load over, so a broken store reads as "no preference".
 */

import type { Baseline } from './summary.ts';

const AI_WANTED = 'lituus.ai-wanted';
const BASELINE = 'lituus.baseline';

export function aiWanted(): boolean {
  try {
    return localStorage.getItem(AI_WANTED) === 'true';
  } catch {
    return false;
  }
}

export function setAiWanted(on: boolean): void {
  try {
    localStorage.setItem(AI_WANTED, String(on));
  } catch {
    /* blocked or full; the setting simply does not survive the tab */
  }
}

/**
 * What the summary measures from: the move the game played, or the engine's
 * own. A preference like any other — it is a way of reading the same session,
 * not a fact about it, and re-choosing it every visit would grate exactly as
 * re-ticking the scoring box does.
 */
export function baselineWanted(): Baseline {
  try {
    return localStorage.getItem(BASELINE) === 'engine' ? 'engine' : 'played';
  } catch {
    return 'played';
  }
}

export function setBaselineWanted(baseline: Baseline): void {
  try {
    localStorage.setItem(BASELINE, baseline);
  } catch {
    /* blocked or full; the setting simply does not survive the tab */
  }
}
