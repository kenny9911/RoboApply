// server/src/features/skills/canonicalize.ts
//
// The write path of the vocabulary (SM-6; MATCH 4.6): a skill string from a
// posting or a resume → a canonical skill id.
//
//   1. Exact alias: the vocabulary knows the string in some spelling or script.
//   2. A strict embedding neighbour, only when the caller passes `embed` and
//      `nearest`: the nearest reviewed skill by cosine, accepted at
//      SKILL_EMBED_MATCH_MIN (0.86) or more AND when the runner-up is at least
//      0.03 lower. An accepted match stores the string's key as an alias of
//      that skill, so the next lookup is step 1.
//   3. Otherwise, when the caller passes `create`: a new skill, status
//      `unreviewed`, kind `hard`. An unreviewed skill is shown on cards and is
//      never scored.
//   4. With no dependencies: { skillId: null, via: 'none' }.
//
// Nothing here is wired to an embeddings client or to the database by
// default: the enrichment of phase M4 passes `embed` (the embeddings client)
// and `skillStoreDeps(db, { model })` (the three database functions below).
// With no `embed`, or when it returns null (no key, policy refusal), nothing
// is embedded and nothing fails: steps 1 and 3 still run.
//
// The label vector lives in RASkill.embedding, an Unsupported halfvec(1024)
// column the Prisma client cannot write: `nearestSkills` and
// `writeSkillEmbedding` use raw SQL (server/prisma/sql/README.md).

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { foldTwToCn } from '../jobs/normalize/index.js';
import { displayTerm, termParts } from './terms.js';
import { aliasKey, hasHan, isListOnlyWord } from './keys.js';
import { createPrismaSkillRepo, type SkillRepo, type SkillWrite } from './repo.js';
import { SEED_SKILL_IDS } from './seed/index.js';
import { skillIdsInText } from './text.js';
import { SKILL_STATUS_SEED, type CanonicalSkill, type SkillRecord, type SkillSnapshot } from './types.js';
import { current, ready, rememberAlias, rememberSkill } from './vocabulary.js';

/** Cosine at or above which an unknown string is mapped to its nearest canonical skill. */
export const SKILL_EMBED_MATCH_MIN_DEFAULT = 0.86;
/** The threshold is never set lower than this, whatever the environment says. */
export const SKILL_EMBED_MATCH_FLOOR = 0.8;
/** The runner-up must be at least this far below the best neighbour. */
export const SKILL_EMBED_MARGIN = 0.03;
/** Neighbours read per string (the best and the runner-up decide; one more for the log). */
export const SKILL_NEIGHBOURS = 3;
/** Dimensions of RASkill.embedding (halfvec(1024); never edited). */
export const SKILL_EMBED_DIMENSIONS = 1024;
/** A longer string is a sentence, not a skill name: it is never created as a skill and never sent to the embeddings endpoint. */
export const SKILL_TERM_MAX_CHARS = 60;

const EPSILON = 1e-9;

/** SKILL_EMBED_MATCH_MIN from the environment: 0.86 when absent or not a number, never below 0.8, never above 1. */
export function skillEmbedMatchMin(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SKILL_EMBED_MATCH_MIN;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return SKILL_EMBED_MATCH_MIN_DEFAULT;
  return Math.min(1, Math.max(SKILL_EMBED_MATCH_FLOOR, n));
}

export interface SkillNeighbour {
  id: string;
  cosine: number;
}

export interface CanonicalizeDeps {
  /** One call for many strings. Null means the embeddings client is unavailable: step 2 is skipped. */
  embed?: (texts: string[]) => Promise<number[][] | null>;
  /** The nearest reviewed skills of a vector, best first. */
  nearest?: (vector: number[], limit: number) => Promise<SkillNeighbour[]>;
  /** Store a new unreviewed skill. Must be safe to call twice for the same id. */
  create?: (record: SkillRecord & { mentionCount: number }) => Promise<void>;
  /** Store an alias key learned in step 2. Without it the alias is known to this process only. */
  learn?: (skillId: string, aliasKey: string) => Promise<void>;
  /** Default: the process-wide vocabulary, loaded first. */
  vocabulary?: SkillSnapshot;
  /** Defaults: `skillEmbedMatchMin()` and SKILL_EMBED_MARGIN. */
  minCosine?: number;
  margin?: number;
}

const NONE: CanonicalSkill = { skillId: null, status: 'unreviewed', via: 'none' };

function known(vocabulary: SkillSnapshot, id: string, via: CanonicalSkill['via']): CanonicalSkill {
  return { skillId: id, status: vocabulary.reviewed(id) ? 'reviewed' : 'unreviewed', via };
}

/**
 * May this string be sent to the embeddings endpoint? At least 2 characters,
 * no longer than a skill name (a sentence is never created, so it would be
 * embedded again on every posting that carries it), and not a word that is
 * also something else.
 */
function embeddable(term: string): boolean {
  const length = [...term].length;
  return length >= 2 && length <= SKILL_TERM_MAX_CHARS && !isListOnlyWord(term);
}

/** May this string become a new skill? A short name with a letter or a digit in it. */
function creatable(term: string, key: string): boolean {
  return !!key && [...term].length <= SKILL_TERM_MAX_CHARS && /[\p{L}\p{N}]/u.test(term);
}

function usableVector(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Map many skill strings at once. One `embed` call covers every string that
 * needs it. The result has one entry per input, in the same order; the same
 * string twice gives the same entry.
 */
export async function canonicalizeMany(terms: readonly string[], deps: CanonicalizeDeps = {}): Promise<CanonicalSkill[]> {
  if (!deps.vocabulary) await ready();
  const vocabulary = deps.vocabulary ?? current();
  const minCosine = deps.minCosine ?? skillEmbedMatchMin();
  const margin = deps.margin ?? SKILL_EMBED_MARGIN;

  const byKey = new Map<string, CanonicalSkill>();
  /** Strings no alias knows, one per key, in input order. */
  const open: Array<{ key: string; term: string }> = [];
  const cleaned = terms.map((raw) => String(raw ?? '').normalize('NFKC').trim().replace(/\s+/g, ' '));
  for (const term of cleaned) {
    const key = aliasKey(term);
    if (byKey.has(key)) continue;
    if (!key || vocabulary.isDropped(term)) {
      byKey.set(key, NONE);
      continue;
    }
    const id = vocabulary.idOfKey(key);
    if (id) {
      byKey.set(key, known(vocabulary, id, 'alias'));
      continue;
    }
    byKey.set(key, NONE);
    open.push({ key, term });
  }

  // Step 2: one embedding call, then the nearest skills of each vector.
  const resolved = new Set<string>();
  const toEmbed = deps.embed && deps.nearest ? open.filter((o) => embeddable(o.term)) : [];
  if (toEmbed.length) {
    const vectors = await deps.embed!(toEmbed.map((o) => o.term));
    if (vectors && vectors.length === toEmbed.length) {
      for (let i = 0; i < toEmbed.length; i++) {
        const { key } = toEmbed[i]!;
        const vector = vectors[i];
        if (!usableVector(vector)) continue;
        // An earlier string of this batch may have taught the vocabulary this key.
        const already = vocabulary.idOfKey(key);
        if (already) {
          byKey.set(key, known(vocabulary, already, 'alias'));
          resolved.add(key);
          continue;
        }
        // A row the vocabulary does not hold (the copy of a skill the seed no longer has) is not a neighbour.
        const neighbours = (await deps.nearest!(vector, SKILL_NEIGHBOURS))
          .filter((n) => n && typeof n.id === 'string' && Number.isFinite(n.cosine) && vocabulary.record(n.id) !== null)
          .sort((a, b) => b.cosine - a.cosine);
        const best = neighbours[0];
        const second = neighbours[1];
        if (!best) continue;
        if (best.cosine + EPSILON < minCosine) continue;
        if (second && best.cosine - second.cosine + EPSILON < margin) continue;
        // The key is remembered only when the vocabulary gives it to this skill.
        if (rememberAlias(vocabulary, best.id, key) && deps.learn) await deps.learn(best.id, key);
        byKey.set(key, known(vocabulary, best.id, 'embedding'));
        resolved.add(key);
      }
    }
  }

  // Step 3: a new unreviewed skill for what is still unknown.
  if (deps.create) {
    for (const { key, term } of open) {
      if (resolved.has(key) || !creatable(term, key)) continue;
      const taken = vocabulary.idOfKey(key) ?? (vocabulary.record(key) ? key : null);
      if (taken) {
        byKey.set(key, known(vocabulary, taken, 'alias'));
        continue;
      }
      // A Chinese string is also the label of its own script, and of no other: label(id, 'zh-TW') never returns
      // Simplified text. A string the fold leaves unchanged is taken as Simplified (the cautious reading for Taiwan).
      const chinese = hasHan(term);
      const simplified = chinese && foldTwToCn(term) === term;
      const record: SkillRecord = {
        // The id is the key itself: two workers that meet the same new string create the same row.
        id: key,
        kind: 'hard',
        labelEn: displayTerm(term),
        labelZh: chinese && simplified ? term : null,
        labelZhHant: chinese && !simplified ? term : null,
        aliases: [],
        aliasKeys: [key],
        parentId: null,
        esco: null,
        onet: null,
        status: 'unreviewed',
      };
      await deps.create({ ...record, mentionCount: 1 });
      rememberSkill(vocabulary, record);
      byKey.set(key, { skillId: key, status: 'unreviewed', via: 'new' });
    }
  }

  return cleaned.map((term) => byKey.get(aliasKey(term)) ?? NONE);
}

/** Map one skill string. See the file header for the order of the steps. */
export async function canonicalize(term: string, deps: CanonicalizeDeps = {}): Promise<CanonicalSkill> {
  return (await canonicalizeMany([term], deps))[0]!;
}

/**
 * The canonical skills of a person: the ids of their listed skills, plus
 * every reviewed skill one of whose names appears as a whole word in the
 * resume text (text.ts).
 *
 * A listed skill counts whole ("Go", "REST"), by its parts when every part is
 * a skill ("TypeScript / Node.js", "React and Redux"), and otherwise by the
 * names inside it ("Advanced PostgreSQL tuning"). A name that is also an
 * ordinary word (rest, excel, swift, go) counts only as a listed skill, never
 * from a sentence and never from inside a longer entry ("go-to-market
 * strategy" is not Go, "rest and recovery coaching" is not REST): the rule
 * terms.ts applies.
 */
export function userSkillIds(skills: readonly string[], resumeText: string | null | undefined, vocabulary: SkillSnapshot = current()): string[] {
  const out = new Set<string>();
  const addReviewedFromText = (text: string) => {
    for (const id of skillIdsInText(text, { vocabulary })) if (vocabulary.reviewed(id)) out.add(id);
  };
  for (const skill of skills) {
    if (typeof skill !== 'string' || !skill.trim()) continue;
    const id = vocabulary.idOf(skill);
    if (id) {
      out.add(id);
      continue;
    }
    // "TypeScript / Node.js", "React and Redux": a list of skills in one entry, when every part is a skill.
    const parts = termParts(skill);
    const partIds = parts.length > 1 ? parts.map((part) => vocabulary.idOf(part)) : [];
    if (partIds.length && partIds.every((partId) => partId !== null)) {
      for (const partId of partIds) out.add(partId!);
      continue;
    }
    // Anything else is read like a sentence ("Advanced PostgreSQL tuning").
    addReviewedFromText(skill);
  }
  if (resumeText) addReviewedFromText(resumeText);
  return [...out];
}

// ── Database functions for the dependencies above ─────────────────────────

/** What the raw statements need (the label vector). */
export type RawDb = Pick<ExtendedPrismaClient, '$queryRaw' | '$executeRaw'>;
/** What `skillStoreDeps` needs: the raw statements and the RASkill delegate. */
export type SkillStoreDb = RawDb & Pick<ExtendedPrismaClient, 'rASkill' | '$transaction'>;

/** A vector as the text pgvector reads: "[0.1,0.2,…]". Throws on a wrong length, a value that is not a number, or a vector of zeros (no embedding: its cosine to anything is NaN). */
export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== SKILL_EMBED_DIMENSIONS) throw new Error(`A skill vector has ${SKILL_EMBED_DIMENSIONS} dimensions; got ${vector.length}.`);
  if (!vector.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error('A skill vector holds a value that is not a finite number.');
  if (!vector.some((x) => x !== 0)) throw new Error('A skill vector of zeros is not an embedding.');
  return `[${vector.join(',')}]`;
}

/**
 * The nearest reviewed skills by cosine over RASkill.embedding, among rows
 * whose vector was made by `model` (vectors of two models are never compared).
 * A reviewed skill is a `reviewed` row or the `seed` row of a seed skill (every
 * seed skill is reviewed); an unreviewed or dropped row is never a neighbour.
 */
export async function nearestSkills(db: RawDb, vector: readonly number[], options: { model: string; limit?: number }): Promise<SkillNeighbour[]> {
  const literal = vectorLiteral(vector);
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? SKILL_NEIGHBOURS)));
  const rows = await db.$queryRaw<Array<{ id: string; cosine: number | string }>>`
    SELECT s."id", (1 - (s."embedding" <=> ${literal}::halfvec))::float8 AS cosine
    FROM "RASkill" s
    WHERE s."embedding" IS NOT NULL AND s."embeddingModel" = ${options.model} AND s."status" IN ('reviewed', 'seed')
    ORDER BY s."embedding" <=> ${literal}::halfvec
    LIMIT ${limit}
  `;
  // A cosine that is not a number (a zero vector stored before the guards) is no neighbour.
  return rows.map((r) => ({ id: r.id, cosine: Number(r.cosine) })).filter((r) => Number.isFinite(r.cosine));
}

/** Write one label vector and the model that made it. Returns false when the row does not exist. */
export async function writeSkillEmbedding(db: RawDb, id: string, vector: readonly number[], model: string): Promise<boolean> {
  const literal = vectorLiteral(vector);
  const n = await db.$executeRaw`
    UPDATE "RASkill" SET "embedding" = ${literal}::halfvec, "embeddingModel" = ${model}, "updatedAt" = now()
    WHERE "id" = ${id}
  `;
  return Number(n) > 0;
}

/** Ids of rows that have a label vector made by `model`. */
export async function embeddedSkillIds(db: RawDb, model: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "RASkill" s WHERE s."embedding" IS NOT NULL AND s."embeddingModel" = ${model} ORDER BY s."id"
  `;
  return rows.map((r) => r.id);
}

/** Rows that carry a label vector made by a model other than `model`, with that model ('' when none was recorded). */
export async function otherModelSkillIds(db: RawDb, model: string): Promise<Array<{ id: string; model: string }>> {
  const rows = await db.$queryRaw<Array<{ id: string; model: string | null }>>`
    SELECT s."id", s."embeddingModel" AS model FROM "RASkill" s
    WHERE s."embedding" IS NOT NULL AND s."embeddingModel" IS DISTINCT FROM ${model} ORDER BY s."id"
  `;
  return rows.map((r) => ({ id: r.id, model: r.model ?? '' }));
}

/** A record as the row the table stores: every label and alias as a comparison key. */
export function rowOfRecord(record: SkillRecord, status: string = record.status): SkillWrite {
  const keys = new Set<string>();
  for (const name of [record.labelEn, record.labelZh, record.labelZhHant, ...record.aliases]) if (name) keys.add(aliasKey(name));
  for (const key of record.aliasKeys ?? []) keys.add(key);
  keys.delete('');
  return {
    id: record.id,
    kind: record.kind,
    labelEn: record.labelEn,
    labelZh: record.labelZh,
    labelZhHant: record.labelZhHant,
    aliases: [...keys].sort(),
    parentId: record.parentId,
    esco: record.esco,
    onet: record.onet,
    status,
  };
}

/**
 * The row an automatic step writes for a skill that has none yet (a learned
 * alias, `embed-labels`, `attach-ids`, the target of a merge). For a seed
 * skill it is a marker of status `seed` with no alias keys of its own: the
 * skill stays what the committed seed says, and whatever the row holds later
 * is something the table added (vocabulary.ts `mergeOverSeed`). It must never
 * read as a review decision, or a later change to the seed would be undone by
 * the copy. Any other skill is written as it is.
 */
export function missingRowOf(record: SkillRecord, seedIds: ReadonlySet<string> = SEED_SKILL_IDS): SkillWrite {
  if (!seedIds.has(record.id)) return rowOfRecord(record);
  return { ...rowOfRecord(record), aliases: [], status: SKILL_STATUS_SEED };
}

/**
 * `nearest`, `create` and `learn` over the database, for a caller that has an
 * embeddings client: `canonicalizeMany(terms, { embed, ...skillStoreDeps(db, { model }) })`.
 * `model` is the tag of the embedding model in use (the embeddings client's
 * `modelTag`).
 *
 * A seed skill has no row until something writes one, so `learn` first
 * creates its `seed` row (`missingRowOf`) and then adds the key.
 */
export function skillStoreDeps(
  db: SkillStoreDb,
  options: { model: string; repo?: SkillRepo; vocabulary?: () => SkillSnapshot; seedIds?: ReadonlySet<string> },
): Required<Pick<CanonicalizeDeps, 'nearest' | 'create' | 'learn'>> {
  const repo = options.repo ?? createPrismaSkillRepo(async () => db);
  const vocabulary = options.vocabulary ?? current;
  return {
    nearest: (vector, limit) => nearestSkills(db, vector, { model: options.model, limit }),
    create: async (record) => {
      await repo.createMissing([{ ...rowOfRecord(record), mentionCount: record.mentionCount }]);
    },
    learn: async (skillId, key) => {
      if (await repo.addAliasKeys(skillId, [key])) return;
      const record = vocabulary().record(skillId);
      if (!record) return;
      await repo.createMissing([missingRowOf(record, options.seedIds)]);
      await repo.addAliasKeys(skillId, [key]);
    },
  };
}
