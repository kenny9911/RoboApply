// server/src/features/match/terms.ts
//
// How skill and keyword terms are compared, de-duplicated and written
// (FIX-3). The keyword check used to be literal: a resume listing AWS,
// PostgreSQL and REST APIs was told it was missing "cloud infrastructure",
// "relational databases" and "api design", the same thing appeared two or
// three times ("typescript/node.js", "TypeScript", "Node.js"), and skills were
// printed in the lower case they are stored in ("go", "mysql", "grpc").
//
//   shownBy        the named technology on the resume that shows a broader
//                  term the post uses (AWS → cloud infrastructure). Only
//                  specific → general, never the other way round: "cloud
//                  infrastructure" on a resume does not show AWS. The check
//                  reports WHICH term counted, so nothing is claimed that the
//                  reader cannot see.
//   termKey        comparison key: skillKey plus singular/plural.
//   dedupeTerms    one entry per thing: exact repeats, "a/b" when a and b are
//                  both listed, and a longer phrase that only adds words to a
//                  listed one ("shared backend systems and frameworks").
//   displayTerm    the usual spelling of a known technology (Go, MySQL, gRPC,
//                  Node.js); anything else keeps the casing it came with, or
//                  gets a capital first letter when it is all lower case.
//   isEverydayWord a technology name that is also an ordinary word (rest,
//                  excel, swift, react, oracle, less). The resume text is
//                  compared in lower case, so "the rest of the migration" and
//                  "REST" look the same: such a name is never taken from a
//                  sentence as proof of a broader skill, and never re-spelled
//                  inside a phrase that names no other technology.
//
// Pure data and functions. Nothing here calls a model or reads the database.
//
// MKT-2G: the comparison key, the two tables (`EVERYDAY_WORDS`, `SHOWN_BY`,
// now exported), `termParts`, `dedupeTerms` and `displayTerm` live in
// features/skills/terms.ts, unchanged, because the canonical skill vocabulary
// is built on them and is the layer below the match. This file re-exports
// them, so every caller here imports what it imported before. What only the
// match uses stays here: `showingTerms` and `titleShows`.

import { SHOWN_BY, termKey } from '../skills/index.js';

export { dedupeTerms, displayTerm, EVERYDAY_WORDS, isEverydayWord, SHOWN_BY, termKey, termParts, termWords } from '../skills/index.js';

// ── Named technology → the broader term a post may use ────────────────────

const SHOWN_BY_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [general, specific] of SHOWN_BY) {
    for (const g of general) {
      const key = termKey(g);
      m.set(key, [...(m.get(key) ?? []), ...specific]);
    }
  }
  return m;
})();

/** Named technologies that show the broader term `term` (empty when the term is not a broader one we know). */
export function showingTerms(term: string): readonly string[] {
  return SHOWN_BY_INDEX.get(termKey(term)) ?? [];
}

/** Roles whose own title shows the practice the post names ("software engineering" for a Software Engineer). */
const PRACTICE_OF_ROLE: ReadonlyArray<readonly [practice: readonly string[], role: RegExp]> = [
  [['software engineering', 'software development', 'programming', 'coding', '软件开发', '軟體開發'], /\b(software|backend|back-end|frontend|front-end|full[- ]?stack|mobile|ios|android|web|platform)\s+(engineer|developer)\b|\bsde\b|\bswe\b|\bprogrammer\b|软件工程师|開發工程師|开发工程师/i],
  [['data analysis', 'data analytics', 'analytics', '数据分析'], /\bdata\s+(analyst|scientist)\b|\banalytics\s+engineer\b|数据分析师/i],
  [['product management', '产品管理'], /\bproduct\s+manager\b|产品经理|產品經理/i],
  [['product design', 'ux design', 'user experience design', 'ui/ux design'], /\b(product|ux|ui\/ux|ui|interaction)\s+designer\b/i],
  [['project management', '项目管理'], /\b(project|program)\s+manager\b|项目经理|專案經理/i],
];

/** Does a job title show the practice `term` names? */
export function titleShows(title: string | null | undefined, term: string): boolean {
  if (!title) return false;
  const key = termKey(term);
  return PRACTICE_OF_ROLE.some(([practices, role]) => practices.some((p) => termKey(p) === key) && role.test(title));
}
