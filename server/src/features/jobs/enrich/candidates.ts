// server/src/features/jobs/enrich/candidates.ts
//
// Candidate taxonomy preselection (ARCHITECTURE.md §4.5): the model may only
// pick a role id from a list of at most 15 roles chosen here by keyword
// overlap, so it cannot invent ids. Order:
//   1. the deterministic title matches (taxonomy/match.ts, a lower bar than
//      ingest's 0.6 because the model makes the final call): the
//      deterministic pick is always first;
//   2. the role the row already holds, so the model can confirm it (SM-2: it
//      may now overrule a weak title match, and must be able to keep it);
//   3. for a title that ends on a head noun ("Java Backend Architect"), the
//      roles the modifier lexicon connects to its other words, then the other
//      roles the lexicon lists for that head noun when they all fit
//      ("architect": the building profession and the software, cloud, data,
//      security and network architects), so the model always sees the other
//      reading. A head noun with dozens of roles ("engineer") adds only the
//      connected ones; at most two thirds of the list comes from the lexicon;
//   4. roles whose labels/synonyms share words with the title (weight 3) or
//      the first part of the description (weight 1). A head noun is not such
//      a word: "engineer" says nothing about the discipline.
// Generic catch-all roles rank below specific ones on equal overlap.

import {
  HEAD_NOUNS,
  TAXONOMY_NODES,
  headNounOf,
  headNounRoles,
  lexiconCandidates,
  normalizeTitle,
  stripLevelWords,
  taxonomyAncestors,
  type TaxonomyNode,
} from '../taxonomy/index.js';
import { MAX_TAXONOMY_CANDIDATES } from './schema.js';
import { titleMatches, titleReadings } from './titleEvidence.js';

const CJK = /[㐀-鿿豈-﫿]/;
/** Description characters scanned for overlap. */
const DESCRIPTION_SCAN_CHARS = 1500;

/** Words that carry no role signal. */
const NOISE = new Set([
  'and', 'or', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'on', 'with', 'at', 'by', 'we', 'you', 'our', 'your',
  'is', 'are', 'be', 'will', 'as', 'job', 'role', 'position', 'team', 'work', 'specialist', 'associate',
  'assistant', 'officer', 'professional', 'staff', 'senior', 'junior', 'lead', 'head', 'manager',
  ...HEAD_NOUNS,
]);

interface RolePhrases {
  node: TaxonomyNode;
  tokens: Set<string>;
  cjk: string[];
}

const ROLES: RolePhrases[] = TAXONOMY_NODES.filter((n) => n.level === 3).map((node) => {
  const tokens = new Set<string>();
  const cjk: string[] = [];
  for (const raw of [node.en, node.zh, ...node.synonyms.en, ...node.synonyms.zh]) {
    const text = normalizeTitle(raw);
    if (!text) continue;
    if (CJK.test(text)) cjk.push(text.replace(/ /g, ''));
    else for (const t of text.split(' ')) if (t.length > 1 && !NOISE.has(t)) tokens.add(t);
  }
  return { node, tokens, cjk };
});

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeTitle(text)
      .split(' ')
      .filter((t) => t.length > 1 && !NOISE.has(t)),
  );
}

export interface TaxonomyCandidate {
  id: string;
  en: string;
  zh: string;
  /** "Category › Group", for the prompt. */
  path: string;
}

function toCandidate(node: TaxonomyNode): TaxonomyCandidate {
  const chain = taxonomyAncestors(node.id).reverse();
  return { id: node.id, en: node.en, zh: node.zh, path: chain.slice(0, -1).map((n) => n.en).join(' › ') };
}

const ROLE_BY_ID = new Map(ROLES.map((r) => [r.node.id, r.node]));

/**
 * Up to `limit` (≤15) role candidates for a posting, best first. `held` is
 * the role the row already has, if any: it is always offered.
 */
export function selectTaxonomyCandidates(
  title: string,
  description: string,
  limit: number = MAX_TAXONOMY_CANDIDATES,
  held: readonly (string | null | undefined)[] = [],
): TaxonomyCandidate[] {
  const cap = Math.max(1, Math.min(MAX_TAXONOMY_CANDIDATES, limit));
  const picked = new Map<string, TaxonomyNode>();
  const pick = (id: string | null | undefined) => {
    const node = id ? ROLE_BY_ID.get(id) : undefined;
    if (node && picked.size < cap) picked.set(node.id, node);
  };
  for (const m of titleMatches(title, { limit: 5, minScore: 0.4 })) pick(m.id);
  for (const id of held) pick(id);
  // A Taiwan title is read in its mainland form too (the taxonomy's Chinese phrases are Simplified).
  const readings = titleReadings(title);
  // Leave room for the keyword overlap below: at most two thirds of the list comes from the lexicon.
  const room = Math.max(1, Math.ceil((cap * 2) / 3));
  for (const reading of readings) {
    const head = headNounOf(reading);
    if (!head) continue;
    for (const id of lexiconCandidates(reading)) if (picked.size < room) pick(id);
    const family = headNounRoles(head).filter((id) => !picked.has(id));
    if (picked.size + family.length <= room) for (const id of family.sort()) pick(id);
  }

  const titleTokens = tokenSet(stripLevelWords(normalizeTitle(title)));
  const descHead = description.slice(0, DESCRIPTION_SCAN_CHARS);
  const descTokens = tokenSet(descHead);
  const titleCompact = readings.map((r) => normalizeTitle(r).replace(/ /g, '')).join(' ');
  const descCompact = titleReadings(descHead)
    .map((r) => normalizeTitle(r).replace(/ /g, ''))
    .join(' ');

  const scored: Array<{ node: TaxonomyNode; score: number }> = [];
  for (const role of ROLES) {
    if (picked.has(role.node.id)) continue;
    let score = 0;
    for (const t of role.tokens) {
      if (titleTokens.has(t)) score += 3;
      else if (descTokens.has(t)) score += 1;
    }
    for (const phrase of role.cjk) {
      if (phrase.length < 2) continue;
      if (titleCompact.includes(phrase)) score += 3 * Math.min(phrase.length, 4);
      else if (descCompact.includes(phrase)) score += Math.min(phrase.length, 4);
    }
    if (score > 0) scored.push({ node: role.node, score: role.node.generic ? score - 0.5 : score });
  }
  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  for (const s of scored) {
    if (picked.size >= cap) break;
    picked.set(s.node.id, s.node);
  }
  return [...picked.values()].slice(0, cap).map(toCandidate);
}

/** `RAJob.taxonomyIds` for a role id: [category, group, role]. Empty for unknown ids. */
export function taxonomyIdsFor(roleId: string): string[] {
  return taxonomyAncestors(roleId)
    .reverse()
    .map((n) => n.id);
}
