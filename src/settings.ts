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

const AI_WANTED = 'lituus.ai-wanted';

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
