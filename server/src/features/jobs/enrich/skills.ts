// server/src/features/jobs/enrich/skills.ts
//
// The canonical-skill side of enrichment (SM-6; MATCH 4.6 write path): the
// strings a posting lists become canonical skill ids of the vocabulary
// (features/skills, table RASkill), once per job, before reconcile runs.
//
//   const vocabulary = await port.vocabulary();
//   const results = await port.canonicalize(terms, { brand, write });
//   const map = buildSkillMap(terms, results, vocabulary);   // term → { skillId, kind, status, via }
//
// reconcile.ts stays pure: it receives the map. keywords.ts receives the
// vocabulary for its synchronous lookups.
//
// What `canonicalize` does (the default port, `createEnrichSkillsPort`):
//   - `write: false` (a user's own import): the exact-alias step only. An
//     import reads the shared vocabulary and never adds to it, and none of its
//     text is sent to the embeddings endpoint (so no embedding call is made on
//     GoApply without the AI consent, and none on a request path).
//   - no embedding key for the brand: the exact-alias step only.
//   - otherwise: exact alias, then ONE embedding request for the strings no
//     alias knows (`purpose: 'skill'`, no user data), the nearest reviewed
//     skill at the strict threshold of features/skills, and a new unreviewed
//     skill for what is still unknown (shown, never scored).
//   - when the embedding step cannot decide, no skill is created and the job
//     gets the exact-alias answer: the client answers unavailable (policy,
//     budget), the call fails, or RASkill holds no label vector for the model
//     in use (`embed-labels` has not run: the neighbour query answers nothing).
//     In the last case nothing is embedded for that model for
//     LABEL_VECTOR_RETRY_MS, so a table without vectors costs one embedding
//     request per pause, not one per job. The same answer when the skills
//     table cannot be read or written part of the way; a skill stored before
//     the failure is still answered as created (`via: 'new'`), so its first
//     posting is not counted twice. Enrichment never fails on this step: the
//     model call is already paid for, and a retry of the work item would pay
//     for it again.
//   - A row is enriched ONCE per ENRICH_VERSION. Strings left without an id
//     by a pass that could not embed stay that way until the row is mapped
//     again: by a forced pass, by the next version, or by a skills-only pass
//     (`{ jobId, skillsOnly: true }`, service.ts), which asks the vocabulary
//     again and makes no model call. So the embedding key and the label
//     vectors (`embed-labels`) belong in place BEFORE the version-3 pass runs.
//
// A string mapped by an embedding neighbour is a machine guess. It is stored
// with `via: 'embedding'` on the row (`skillsDetail[].via`) and the alias is
// NOT written to RASkill (`learn` is not passed): the table cannot tell a
// learned alias from a reviewed one, and `export-seed` would copy it into the
// committed reviewed seed (requests/waveM2-carryover.md, MKT-4D 5a). The
// loaded vocabulary still takes the alias (features/skills `rememberAlias`)
// and keeps it until its next reload. So this port remembers, per loaded
// vocabulary, which keys it guessed, and for as long as that vocabulary is in
// use:
//   - its answer for such a key stays `via: 'embedding'`;
//   - the vocabulary it hands to the keyword list (`vocabulary()`) does not
//     know the key: no other posting whose text contains the string gets the
//     guessed skill as a keyword.
// A reloaded vocabulary has no such alias unless a reviewer stored it, and
// then it is a reviewed alias like any other.
//
// Importing this file loads neither the vocabulary nor the embeddings client
// nor a database: each is imported on first use.

import type { BrandId } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import type { CanonicalSkill, SkillKind, SkillRecord, SkillSnapshot } from '../../skills/index.js';

/** How a skill string reached its canonical id. */
export type SkillVia = CanonicalSkill['via'];

/** What the vocabulary says about one skill string of a posting. */
export interface SkillMapping {
  /** Null when the vocabulary holds no skill for the string. */
  skillId: string | null;
  /** The vocabulary's kind of that skill; null without one. */
  kind: SkillKind | null;
  /** `dropped`: a reviewer ruled that the string is not a skill; it is not stored. */
  status: 'reviewed' | 'unreviewed' | 'dropped';
  via: SkillVia;
  /** The skill's own names (English, Simplified, Traditional), as `skillMapKey` writes them. */
  labels: readonly string[];
}

/** `skillMapKey(term)` → what the vocabulary says about it. */
export type SkillMap = ReadonlyMap<string, SkillMapping>;

/** How enrichment writes a skill string (`RAJob.skills`: NFKC, lower case, single spaces), and the key of a `SkillMap`. */
export function skillMapKey(term: string): string {
  return term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** What enrichment reads of the vocabulary: synchronous lookups over one snapshot. */
export interface EnrichVocabulary extends Pick<SkillSnapshot, 'idOf' | 'kindOf' | 'reviewed' | 'label' | 'isDropped'> {
  /**
   * Ids of the skills a piece of the posting's text names, by the vocabulary's
   * own rule for words taken from a sentence (features/skills
   * `skillIdsInText`): a name is found only where the text writes it, two
   * ordinary words never spell a tool ("work day" is not Workday), and a name
   * that is also an ordinary word ("go", "rest", "ML") names nothing.
   */
  idsInText(text: string): string[];
}

/** Aliases a snapshot holds that are machine guesses, and what is needed to read the snapshot without them. */
export interface GuessedAliases {
  /** Comparison key → the skill an embedding neighbour gave it. Read on every lookup, so a guess made later counts. */
  keys: ReadonlyMap<string, string>;
  /** features/skills `aliasKey`. */
  aliasKey: (term: string) => string;
  /** features/skills `buildVocabulary`. */
  buildVocabulary: (records: readonly SkillRecord[]) => SkillSnapshot;
}

/**
 * A snapshot of the vocabulary as enrichment reads it. With `guesses`, an
 * alias the snapshot holds only as a machine guess is not a name of the
 * skill: `idOf` does not answer for it, and `idsInText` finds a skill only
 * where the text writes one of its other names.
 */
export function enrichVocabularyOf(
  snapshot: SkillSnapshot,
  skillIdsInText: (text: string, options: { vocabulary: SkillSnapshot }) => string[],
  guesses?: GuessedAliases,
): EnrichVocabulary {
  /** The skill alone, without its guessed aliases, per id (rebuilt when a guess was added since). */
  const withoutGuesses = new Map<string, { guesses: number; vocabulary: SkillSnapshot | null }>();
  /** Is `id` named in `text` by a name that is not a guess? Asked only for a skill that has guessed aliases. */
  const namedWithoutGuess = (id: string, text: string): boolean => {
    if (!guesses) return true;
    let own = withoutGuesses.get(id);
    if (!own || own.guesses !== guesses.keys.size) {
      const record = snapshot.record(id);
      const reviewedKeys = (record?.aliasKeys ?? []).filter((key) => guesses.keys.get(key) !== id);
      own = { guesses: guesses.keys.size, vocabulary: record ? guesses.buildVocabulary([{ ...record, aliasKeys: reviewedKeys }]) : null };
      withoutGuesses.set(id, own);
    }
    return own.vocabulary ? skillIdsInText(text, { vocabulary: own.vocabulary }).includes(id) : true;
  };
  return {
    idOf: (term) => {
      const id = snapshot.idOf(term);
      return id && guesses?.keys.size && guesses.keys.get(guesses.aliasKey(term)) === id ? null : id;
    },
    kindOf: (id) => snapshot.kindOf(id),
    reviewed: (id) => snapshot.reviewed(id),
    label: (id, locale) => snapshot.label(id, locale),
    isDropped: (term) => snapshot.isDropped(term),
    idsInText: (text) => {
      const ids = skillIdsInText(text, { vocabulary: snapshot });
      if (!guesses?.keys.size || !ids.length) return ids;
      const guessedIds = new Set(guesses.keys.values());
      return ids.filter((id) => !guessedIds.has(id) || namedWithoutGuess(id, text));
    },
  };
}

export interface CanonicalizeJobOptions {
  brand: BrandId;
  /**
   * False for a user's own import: the exact-alias step only (nothing is
   * embedded, created or counted).
   */
  write: boolean;
  requestId?: string;
}

/** The vocabulary as enrichment uses it. Every member is called at most once per job. */
export interface EnrichSkillsPort {
  /** The loaded vocabulary (RASkill over the committed seed). Never rejects. */
  vocabulary(): Promise<EnrichVocabulary>;
  /** Map the skill strings of ONE job: one entry per string, in the same order. Never rejects. */
  canonicalize(terms: readonly string[], options: CanonicalizeJobOptions): Promise<CanonicalSkill[]>;
  /** One more posting for each skill id (the review list of the skills CLI is ordered by it). */
  countMentions(ids: readonly string[]): Promise<void>;
}

const NO_SKILL: SkillMapping = { skillId: null, kind: null, status: 'unreviewed', via: 'none', labels: [] };
const NOT_A_SKILL: SkillMapping = { skillId: null, kind: null, status: 'dropped', via: 'none', labels: [] };

/** The answers of `canonicalize` as the map reconcile reads. `results[i]` belongs to `terms[i]`. */
export function buildSkillMap(terms: readonly string[], results: readonly CanonicalSkill[], vocabulary: EnrichVocabulary): Map<string, SkillMapping> {
  const map = new Map<string, SkillMapping>();
  terms.forEach((term, i) => {
    const key = skillMapKey(term);
    if (!key || map.has(key)) return;
    if (vocabulary.isDropped(term)) {
      map.set(key, NOT_A_SKILL);
      return;
    }
    const result = results[i];
    const id = result?.skillId ?? null;
    if (!id) {
      map.set(key, NO_SKILL);
      return;
    }
    const labels = [...new Set(['en', 'zh', 'zh-TW'].map((locale) => skillMapKey(vocabulary.label(id, locale))).filter(Boolean))];
    // The status is the vocabulary's (a `seed` row is a reviewed skill): never the row's.
    map.set(key, { skillId: id, kind: vocabulary.kindOf(id), status: vocabulary.reviewed(id) ? 'reviewed' : 'unreviewed', via: result!.via, labels });
  });
  return map;
}

// ── The default port ──────────────────────────────────────────────────────

type SkillsModule = typeof import('../../skills/index.js');
type EmbeddingsModule = Pick<typeof import('../../../platform/embeddings/index.js'), 'embedTexts' | 'resolveEmbeddingConfig'>;
/** What the store functions of features/skills need of the database. */
type SkillStoreDb = Parameters<SkillsModule['skillStoreDeps']>[0];

export interface EnrichSkillsPortDeps {
  env?: Record<string, string | undefined>;
  /** Defaults: the real modules, imported on first use. */
  loadSkills?: () => Promise<SkillsModule>;
  loadEmbeddings?: () => Promise<EmbeddingsModule>;
  loadDb?: () => Promise<SkillStoreDb>;
  now?: () => number;
}

/** Keys remembered as machine guesses per loaded vocabulary, at most (the oldest go first). */
export const GUESSED_KEYS_MAX = 20_000;
/** After RASkill answered no label vector for a model, nothing is embedded for that model for this long. */
export const LABEL_VECTOR_RETRY_MS = 5 * 60_000;

/** Why the embedding step did not decide for a job (the job then gets the exact-alias answer). */
class EmbeddingStepOff extends Error {
  constructor(readonly reason: string) {
    super(`skill embedding step off: ${reason}`);
    this.name = 'EmbeddingStepOff';
  }
}

/**
 * The vocabulary port over features/skills, the embeddings client and the
 * database. See the file header for the rules.
 */
export function createEnrichSkillsPort(deps: EnrichSkillsPortDeps = {}): EnrichSkillsPort {
  const env = deps.env ?? process.env;
  const loadSkills = deps.loadSkills ?? (() => import('../../skills/index.js'));
  const loadEmbeddings = deps.loadEmbeddings ?? (() => import('../../../platform/embeddings/index.js'));
  const loadDb = deps.loadDb ?? (async () => (await import('../../../lib/prisma.js')).default as unknown as SkillStoreDb);
  const now = deps.now ?? Date.now;
  /** Loaded vocabulary → (comparison key → the skill an embedding neighbour gave it). Gone with the vocabulary. */
  const guessedBy = new WeakMap<object, Map<string, string>>();
  /** Model tag → when the embedding step may be tried again (RASkill held no label vector for it). */
  const labelVectorsOffUntil = new Map<string, number>();
  /** Model tags already reported as having no label vectors (one warning each). */
  const labelVectorsMissingSaid = new Set<string>();

  function guessesOf(snapshot: SkillSnapshot): Map<string, string> {
    let guessed = guessedBy.get(snapshot);
    if (!guessed) {
      guessed = new Map();
      guessedBy.set(snapshot, guessed);
    }
    return guessed;
  }

  /** Keep `via: 'embedding'` for a key this vocabulary was given by a neighbour, however it answers the key now. */
  function withGuesses(skills: SkillsModule, snapshot: SkillSnapshot, terms: readonly string[], results: CanonicalSkill[]): CanonicalSkill[] {
    const guessed = guessesOf(snapshot);
    return results.map((result, i) => {
      const key = skills.aliasKey(String(terms[i] ?? ''));
      if (!key || !result.skillId) return result;
      if (result.via === 'embedding') {
        if (guessed.size >= GUESSED_KEYS_MAX && !guessed.has(key)) guessed.delete(guessed.keys().next().value as string);
        guessed.set(key, result.skillId);
        return result;
      }
      return result.via === 'alias' && guessed.get(key) === result.skillId ? { ...result, via: 'embedding' as const } : result;
    });
  }

  /**
   * The exact-alias step, the embedding neighbour and the creation of unknown
   * skills. Null when the embedding step is off or failed: the caller then
   * gives the exact-alias answer. `created` collects the ids of the skills
   * stored on the way, also when a later one fails.
   */
  async function withEmbeddings(skills: SkillsModule, snapshot: SkillSnapshot, terms: readonly string[], options: CanonicalizeJobOptions, created: Set<string>): Promise<CanonicalSkill[] | null> {
    const embeddings = await loadEmbeddings();
    const model = embeddings.resolveEmbeddingConfig(options.brand, env).modelTag;
    // No key for the brand: the embeddings client is unavailable, so only the exact-alias step runs.
    if (!model) return null;
    // RASkill answered no label vector for this model a moment ago: nothing is embedded until the pause is over.
    if ((labelVectorsOffUntil.get(model) ?? 0) > now()) return null;
    const store = skills.skillStoreDeps(await loadDb(), { model });
    try {
      return await skills.canonicalizeMany(terms, {
        vocabulary: snapshot,
        embed: async (texts) => {
          const result = await embeddings.embedTexts(options.brand, texts, { purpose: 'skill', carriesUserData: false, requestId: options.requestId ?? null });
          if ('unavailable' in result) throw new EmbeddingStepOff(result.unavailable);
          return result.vectors;
        },
        nearest: async (vector, limit) => {
          const neighbours = await store.nearest(vector, limit);
          // The query has no threshold, so an empty answer means the table holds no label vector made by this
          // model: the neighbour step can decide nothing. Creating skills now would fill RASkill with unreviewed
          // copies of skills it already has under another spelling, so the whole step stops here.
          if (!neighbours.length) throw new EmbeddingStepOff('no_label_vectors');
          return neighbours;
        },
        create: async (record) => {
          await store.create(record);
          created.add(record.id);
        },
      });
    } catch (err) {
      if (err instanceof EmbeddingStepOff) {
        if (err.reason === 'no_label_vectors') {
          labelVectorsOffUntil.set(model, now() + LABEL_VECTOR_RETRY_MS);
          if (!labelVectorsMissingSaid.has(model)) {
            labelVectorsMissingSaid.add(model);
            logger.warn(
              'JOB_ENRICH',
              'RASkill holds no label vector for the embedding model in use: skills are mapped by exact alias only and no unreviewed skill is created until the skills CLI `embed-labels` has run. Rows enriched meanwhile keep that answer until they are mapped again (a skills-only pass)',
              { model, retryInMs: LABEL_VECTOR_RETRY_MS },
            );
          }
        }
        return null;
      }
      // A failed embedding call or a skills-table error: this job is mapped by exact alias.
      logger.warn('JOB_ENRICH', 'canonical skill step failed; the posting keeps the ids an exact alias gives', {
        brand: options.brand,
        requestId: options.requestId ?? null,
        terms: terms.length,
        created: created.size,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return {
    async vocabulary() {
      const skills = await loadSkills();
      await skills.ready();
      const snapshot = skills.current();
      return enrichVocabularyOf(snapshot, skills.skillIdsInText, { keys: guessesOf(snapshot), aliasKey: skills.aliasKey, buildVocabulary: skills.buildVocabulary });
    },
    async canonicalize(terms, options) {
      const skills = await loadSkills();
      if (!terms.length) return [];
      await skills.ready();
      // One vocabulary for every step of this job, so what a step learned is known to the next.
      const snapshot = skills.current();
      const created = new Set<string>();
      let results: CanonicalSkill[] | null = null;
      if (options.write) {
        try {
          results = await withEmbeddings(skills, snapshot, terms, options, created);
        } catch (err) {
          // The embeddings module or the database could not be loaded at all.
          logger.warn('JOB_ENRICH', 'canonical skill step unavailable; the posting keeps the ids an exact alias gives', {
            brand: options.brand,
            requestId: options.requestId ?? null,
            terms: terms.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!results) {
        // The exact-alias answer. The vocabulary knows what the step above stored before it stopped; such a skill
        // is still one this job created (it already counts this posting as its first mention).
        results = (await skills.canonicalizeMany(terms, { vocabulary: snapshot })).map((r) => (r.skillId && r.via === 'alias' && created.has(r.skillId) ? { ...r, via: 'new' as const } : r));
      }
      return withGuesses(skills, snapshot, terms, results);
    },
    async countMentions(ids) {
      const unique = [...new Set(ids)].filter(Boolean);
      if (!unique.length) return;
      const skills = await loadSkills();
      const db = await loadDb();
      await skills.createPrismaSkillRepo(async () => db).incrementMentions(unique);
    },
  };
}
