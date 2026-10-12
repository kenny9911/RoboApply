// server/src/features/skills/cluster.ts
//
// Clusters of the skill strings our own postings carry (MATCH 4.6: seed the
// vocabulary from our own data first). Pure and deterministic: the same
// strings in any order give the same clusters. A cluster is a proposal for a
// reviewer, never a vocabulary entry.
//
// How strings come together, in this order:
//   1. Same comparison key (keys.ts `aliasKey`): "Node.js", "nodejs",
//      "NodeJS"; 機器學習 and 机器学习. Names the vocabulary already knows as
//      one skill ("postgres", "PostgreSQL") are one cluster too.
//   2. A string that lists several skills ("typescript/node.js", "React and
//      Redux": terms.ts `termParts`) is no skill of its own when each part is
//      listed on its own (the rule of terms.ts `dedupeTerms`): its mentions
//      count for each part.
//   3. Keys of 6 or more Latin letters that differ by one letter
//      ("postgressql"): a misspelling. Never across a digit ("http2" and
//      "http3" are two things), never between two keys the vocabulary already
//      knows as two skills ("nestjs" and "nextjs"), never for Chinese (one
//      character changes the meaning: 前端 and 后端).
//   4. A longer phrase whose words contain every word of a listed phrase of
//      two or more words ("advanced machine learning techniques" next to
//      "machine learning": the third rule of `dedupeTerms`).
//
// In the output a member reached by rule 3 is marked "~" and one reached by
// rule 4 is marked "+", so the reviewer sees which ones are guesses.

import { dedupeTerms, termParts, termWords } from './terms.js';
import { aliasKey, hasHan } from './keys.js';
import type { SkillKind, SkillSnapshot } from './types.js';

/** One distinct string of RAJob.skills / skillsDetail with the number of postings that carry it. */
export interface SkillString {
  term: string;
  mentions: number;
  /** The kind enrichment gave it, when it gave one. */
  kind?: string | null;
}

export type MemberVia = 'key' | 'near' | 'phrase';

export interface ClusterMember {
  term: string;
  mentions: number;
  via: MemberVia;
}

export interface SkillCluster {
  /** The comparison key of the label. */
  id: string;
  /** The most frequent spelling. */
  label: string;
  /** Every spelling, most mentioned first. */
  members: ClusterMember[];
  /** Postings that mention any member, plus the combined strings of rule 2. */
  mentions: number;
  kind: SkillKind;
  /** The vocabulary skill this cluster already is, if any. */
  knownId: string | null;
}

export interface ClusterResult {
  clusters: SkillCluster[];
  /** Strings left out: blank, or longer than `maxChars` (a sentence, not a skill name). */
  skipped: number;
}

/** Keys shorter than this are never joined by rule 3. */
export const NEAR_KEY_MIN_LENGTH = 6;
/** A longer string is a sentence. */
export const CLUSTER_TERM_MAX_CHARS = 60;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Do two different keys differ by exactly one inserted, removed or changed letter? */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  if (short.length === long.length) return short.slice(i + 1) === long.slice(i + 1);
  return short.slice(i) === long.slice(i + 1);
}

function nearEligible(key: string): boolean {
  return key.length >= NEAR_KEY_MIN_LENGTH && /^[a-z]+$/.test(key);
}

interface Proto {
  key: string;
  spellings: Map<string, number>;
  mentions: number;
  soft: number;
  hard: number;
}

class Groups {
  private readonly parent = new Map<string, string>();
  find(key: string): string {
    let root = key;
    while (this.parent.has(root)) root = this.parent.get(root)!;
    // Path compression.
    for (let at = key; at !== root; ) {
      const next = this.parent.get(at)!;
      this.parent.set(at, root);
      at = next;
    }
    return root;
  }
  /** The smaller key becomes the root, so the result does not depend on the order of the calls. */
  join(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

export function clusterSkillStrings(strings: readonly SkillString[], options: { vocabulary?: SkillSnapshot; maxChars?: number } = {}): ClusterResult {
  const vocabulary = options.vocabulary ?? null;
  const maxChars = options.maxChars ?? CLUSTER_TERM_MAX_CHARS;
  let skipped = 0;

  // 1. Same key.
  const protos = new Map<string, Proto>();
  for (const s of strings) {
    const term = String(s.term ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    const mentions = Math.max(0, Math.floor(Number(s.mentions) || 0));
    const key = aliasKey(term);
    if (!key || [...term].length > maxChars) {
      skipped++;
      continue;
    }
    const p = protos.get(key) ?? { key, spellings: new Map(), mentions: 0, soft: 0, hard: 0 };
    p.spellings.set(term, (p.spellings.get(term) ?? 0) + mentions);
    p.mentions += mentions;
    if (s.kind === 'soft') p.soft += mentions;
    else if (s.kind === 'hard') p.hard += mentions;
    protos.set(key, p);
  }
  const topSpelling = (p: Proto): string => [...p.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || byText(a[0], b[0]))[0]![0];

  // 2. A string that lists several skills, each listed on its own.
  const extra = new Map<string, number>();
  for (const p of [...protos.values()]) {
    const parts = termParts(topSpelling(p)).map(aliasKey);
    if (parts.length < 2 || !parts.every((k) => k && k !== p.key && protos.has(k))) continue;
    for (const k of new Set(parts)) extra.set(k, (extra.get(k) ?? 0) + p.mentions);
    protos.delete(p.key);
  }

  // Names the vocabulary already knows as one skill are one cluster ("postgres" and "PostgreSQL").
  const groups = new Groups();
  const keys = [...protos.keys()].sort(byText);
  const firstKeyOfId = new Map<string, string>();
  for (const key of keys) {
    const id = vocabulary?.idOfKey(key) ?? null;
    if (!id) continue;
    const first = firstKeyOfId.get(id);
    if (first) groups.join(first, key);
    else firstKeyOfId.set(id, key);
  }

  // 3. One letter apart.
  const bySkeleton = new Map<string, string[]>();
  for (const key of keys) {
    if (!nearEligible(key)) continue;
    const skeletons = new Set([key]);
    for (let i = 0; i < key.length; i++) skeletons.add(key.slice(0, i) + key.slice(i + 1));
    for (const sk of skeletons) bySkeleton.set(sk, [...(bySkeleton.get(sk) ?? []), key]);
  }
  for (const list of bySkeleton.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (!withinOneEdit(a, b)) continue;
        const ia = vocabulary?.idOfKey(a) ?? null;
        const ib = vocabulary?.idOfKey(b) ?? null;
        if (ia && ib && ia !== ib) continue;
        groups.join(a, b);
      }
    }
  }

  // 4. A longer phrase that only adds words to a listed phrase.
  const heads = new Map<string, Proto[]>();
  for (const key of keys) {
    const root = groups.find(key);
    heads.set(root, [...(heads.get(root) ?? []), protos.get(key)!]);
  }
  interface Head {
    root: string;
    label: string;
    words: Set<string>;
    mentions: number;
  }
  const headList: Head[] = [...heads.entries()].map(([root, list]) => {
    const best = [...list].sort((a, b) => b.mentions - a.mentions || byText(a.key, b.key))[0]!;
    const label = topSpelling(best);
    return { root, label, words: new Set(hasHan(label) ? [] : termWords(label)), mentions: list.reduce((n, p) => n + p.mentions, 0) };
  });
  // The rule itself is terms.ts `dedupeTerms`: what it drops is covered by a shorter listed phrase.
  const kept = new Set(dedupeTerms(headList, (h) => h.label).map((h) => h.root));
  const phraseOf = new Map<string, string>();
  for (const h of headList) {
    if (kept.has(h.root) || h.words.size < 3) continue;
    const covering = headList
      .filter((o) => o.root !== h.root && o.words.size >= 2 && o.words.size < h.words.size && [...o.words].every((w) => h.words.has(w)))
      .sort((a, b) => b.words.size - a.words.size || b.mentions - a.mentions || byText(a.root, b.root))[0];
    if (covering) phraseOf.set(h.root, covering.root);
  }
  const finalRoot = (root: string): string => {
    const seen = new Set<string>();
    let at = root;
    while (phraseOf.has(at) && !seen.has(at)) {
      seen.add(at);
      at = phraseOf.get(at)!;
    }
    return at;
  };

  // Assemble.
  const out = new Map<string, { members: ClusterMember[]; mentions: number; soft: number; hard: number; keys: string[] }>();
  for (const [root, list] of heads) {
    const target = finalRoot(root);
    const viaPhrase = target !== root;
    const c = out.get(target) ?? { members: [], mentions: 0, soft: 0, hard: 0, keys: [] };
    const main = [...list].sort((a, b) => b.mentions - a.mentions || byText(a.key, b.key))[0]!;
    const mainId = vocabulary?.idOfKey(main.key) ?? null;
    for (const p of list) {
      const sameSkill = p.key === main.key || (mainId !== null && vocabulary?.idOfKey(p.key) === mainId);
      const via: MemberVia = viaPhrase ? 'phrase' : sameSkill ? 'key' : 'near';
      for (const [term, mentions] of p.spellings) c.members.push({ term, mentions, via });
      c.mentions += p.mentions + (extra.get(p.key) ?? 0);
      c.soft += p.soft;
      c.hard += p.hard;
      if (!viaPhrase) c.keys.push(p.key);
    }
    out.set(target, c);
  }

  const clusters: SkillCluster[] = [...out.values()].map((c) => {
    const rank: Record<MemberVia, number> = { key: 0, near: 1, phrase: 2 };
    const members = [...c.members].sort((a, b) => rank[a.via] - rank[b.via] || b.mentions - a.mentions || a.term.length - b.term.length || byText(a.term, b.term));
    const label = members[0]!.term;
    const knownId = c.keys.map((k) => vocabulary?.idOfKey(k) ?? null).find((id): id is string => !!id) ?? null;
    const kind: SkillKind = (knownId && vocabulary?.kindOf(knownId)) || (c.soft > c.hard ? 'soft' : 'hard');
    return { id: aliasKey(label), label, members, mentions: c.mentions, kind, knownId };
  });
  clusters.sort((a, b) => b.mentions - a.mentions || byText(a.id, b.id));
  return { clusters, skipped };
}
