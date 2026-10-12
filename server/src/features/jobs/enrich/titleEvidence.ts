// server/src/features/jobs/enrich/titleEvidence.ts
//
// What a posting's title says about its role (SM-2), for enrichment and the
// role backfill: the deterministic title match (taxonomy/match.ts) over the
// readings of the title. The taxonomy's Chinese phrases are Simplified, so a
// Taiwan title (資深後端工程師) is also matched in its mainland reading, as
// ingest does (normalize `foldTwToCn`); the reading is used for matching only
// and is never stored or shown.
//
// A match of `TITLE_MATCH_TRUSTED` (0.9) or more means the title names the
// role outright (the exact phrase, or a head noun that is the whole title):
// it decides the role. Anything weaker is the model's to decide.
//
// One more thing the title can say about a role a row already holds: that it
// was put there by a rule that no longer exists. Before SM-2 a single word
// ("architect", "developer", "principal", "server") filed the whole title
// under its role. A held role that only such a word explains, and that
// today's matcher does not support at any score, is replaced by what the
// title says today, or removed when it says nothing: an honest unknown beats
// a wrong category (D3). `roleFromTitle` is the one place this is decided,
// for enrichment and for the backfill.
// Pure; no I/O.

import { foldTwToCn } from '../normalize/index.js';
import { TITLE_MATCH_TRUSTED, matchTitle, oneWordRolesIn, type TitleMatch } from '../taxonomy/index.js';

const HAN = /[㐀-鿿]/;

/** The forms a posting title is matched in: as written and, when it differs, its mainland reading. */
export function titleReadings(title: string): string[] {
  if (!HAN.test(title)) return [title];
  const folded = foldTwToCn(title);
  return folded === title ? [title] : [title, folded];
}

/** Ranked role matches over every reading of the title (the best score per role), best first. */
export function titleMatches(title: string, options: { limit?: number; minScore?: number } = {}): TitleMatch[] {
  const limit = options.limit ?? 3;
  const readings = titleReadings(title);
  if (readings.length === 1) return matchTitle(title, options);
  const best = new Map<string, TitleMatch>();
  // The mainland reading first: on an equal score its match is the one the taxonomy's own phrases made.
  for (const reading of [...readings].reverse()) {
    for (const m of matchTitle(reading, { limit: 50, minScore: options.minScore })) {
      const cur = best.get(m.id);
      if (!cur || m.score > cur.score) best.set(m.id, m);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.id.localeCompare(b.id)).slice(0, limit);
}

/** The deterministic title match for a posting title: the best role and its score, or null. */
export function titleEvidence(title: string): TitleMatch | null {
  return titleMatches(title, { limit: 1 })[0] ?? null;
}

/** True when the title names its role outright (a title match of `TITLE_MATCH_TRUSTED` or more). */
export function titleIsDecisive(match: Pick<TitleMatch, 'score'> | null): boolean {
  return !!match && match.score >= TITLE_MATCH_TRUSTED;
}

/**
 * True when the role a row holds was named only by a word that no longer
 * names a role inside a title ("Java Backend Architect" held under the
 * building profession), and nothing in the title supports it today.
 */
export function heldByRetiredWord(title: string, held: string | null | undefined): boolean {
  if (!held) return false;
  if (!titleReadings(title).some((reading) => oneWordRolesIn(reading).includes(held))) return false;
  return !titleMatches(title, { limit: 1000, minScore: 0 }).some((m) => m.id === held);
}

export interface TitleRuling {
  /** The deterministic title match, or null. */
  det: TitleMatch | null;
  /** True when the title names its role outright: `role` is final and no model is needed for it. */
  decisive: boolean;
  /**
   * What the title alone says the row's role should be: a role id, null
   * (remove the role the row holds) or undefined (the title does not rule:
   * keep what the row holds unless a model picks another).
   */
  role: string | null | undefined;
}

/** What the title alone says about the role of a row that holds `held`. */
export function roleFromTitle(title: string, held: string | null | undefined): TitleRuling {
  const det = titleEvidence(title);
  if (det && titleIsDecisive(det)) return { det, decisive: true, role: det.id };
  if (heldByRetiredWord(title, held)) return { det, decisive: false, role: det ? det.id : null };
  return { det, decisive: false, role: undefined };
}
