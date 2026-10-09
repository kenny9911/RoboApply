// server/src/features/jobs/enrich/candidates.ts
//
// Candidate taxonomy preselection (ARCHITECTURE.md §4.5): the model may only
// pick a role id from a list of at most 15 roles chosen here by keyword
// overlap, so it cannot invent ids. Order:
//   1. the deterministic title matches (taxonomy/match.ts, a lower bar than
//      ingest's 0.6 because the model makes the final call);
//   2. roles whose labels/synonyms share words with the title (weight 3) or
//      the first part of the description (weight 1).
// Generic catch-all roles rank below specific ones on equal overlap.

import {
  TAXONOMY_NODES,
  matchTitle,
  normalizeTitle,
  stripLevelWords,
  taxonomyAncestors,
  type TaxonomyNode,
} from '../taxonomy/index.js';
import { MAX_TAXONOMY_CANDIDATES } from './schema.js';

const CJK = /[㐀-鿿豈-﫿]/;
/** Description characters scanned for overlap. */
const DESCRIPTION_SCAN_CHARS = 1500;

/** Words that carry no role signal. */
const NOISE = new Set([
  'and', 'or', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'on', 'with', 'at', 'by', 'we', 'you', 'our', 'your',
  'is', 'are', 'be', 'will', 'as', 'job', 'role', 'position', 'team', 'work', 'specialist', 'associate',
  'assistant', 'officer', 'professional', 'staff', 'senior', 'junior', 'lead', 'head', 'manager',
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

/** Up to `limit` (≤15) role candidates for a posting, best first. */
export function selectTaxonomyCandidates(
  title: string,
  description: string,
  limit: number = MAX_TAXONOMY_CANDIDATES,
): TaxonomyCandidate[] {
  const cap = Math.max(1, Math.min(MAX_TAXONOMY_CANDIDATES, limit));
  const picked = new Map<string, TaxonomyNode>();
  for (const m of matchTitle(title, { limit: 5, minScore: 0.4 })) {
    const node = ROLES.find((r) => r.node.id === m.id)?.node;
    if (node) picked.set(node.id, node);
  }

  const titleTokens = tokenSet(stripLevelWords(normalizeTitle(title)));
  const descHead = description.slice(0, DESCRIPTION_SCAN_CHARS);
  const descTokens = tokenSet(descHead);
  const titleCompact = normalizeTitle(title).replace(/ /g, '');
  const descCompact = normalizeTitle(descHead).replace(/ /g, '');

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
