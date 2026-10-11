// server/src/features/retrieval/workers.ts — queue workers of the retrieval write path (MKT-2H).
//
// Registered through server/src/features/jobs/enrich/workers.ts (its `workers`
// array is the one platform/queue/registry.ts imports), so the queue registry
// is not edited. The drain runs each item inside `runWithBrand(item.brand)`.
//
//   'job.index'   payload { jobIds: string[] } (1 to 96 ids). For every job:
//                 the search document, `searchTsv`, `contentHash`
//                 (`jobContentHash`, the hash a fit depends on) and `lang` in
//                 ONE statement. That part needs no model and always runs.
//                 Then the card texts of the item go to the embeddings client
//                 in one call and the vectors are stored. A job whose stored
//                 vector already has the current model and card hash is not
//                 embedded again. When the client is unavailable (no key, the
//                 daily budget, the brand's route policy) the item still
//                 succeeds: the lexical part is written and the sweep queues
//                 the rows again once a vector can be written. A user's own import is indexed lexically
//                 always and embedded only when `aiAllowed(owner)` holds (its
//                 text came from the user; the rule enrichment applies).
//   'user.embed'  payload { userId, market }. Builds the intent text and the
//                 resume text (userText.ts), skips a kind whose stored hash is
//                 unchanged, embeds the rest with purpose 'user' and upserts
//                 RAUserEmbedding. Gates, checked here on every run:
//                 RoboApply: none beyond the account existing. GoApply:
//                 the AI consent AND a live 个性化推荐 grant. When a gate
//                 answers a definite "no" the person's vectors of that market
//                 are DELETED (and, with the AI consent gone, the vectors of
//                 their own private imports): no vector outlives a withdrawn
//                 consent. A consent record that cannot be READ is not a
//                 withdrawal: the gates throw, nothing is deleted and the
//                 queue retries the item.
//
// Budgets: concurrency 4 and one HTTP call per item, so no drain run embeds
// more than it can finish in its 240 s budget.

import { DeferWorkError, PermanentWorkError, type LeasedWorkItem, type WorkerDefinition } from '../../platform/queue/index.js';
import type { EmbedOptions, EmbedResult } from '../../platform/embeddings/index.js';
import type { BrandId } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { logger } from '../../services/LoggerService.js';
import { buildCardText, cardHash } from './cardText.js';
import type { IndexJobRow, SkillLabels } from './jobText.js';
import { detectLang } from './lang.js';
import { brandOfMarket, currentModelTag, writeModelTag } from './modelTag.js';
import { defaultRetrievalRepo, type RetrievalRepo, type UserVectorKind } from './repo.js';
import { buildSearchDoc } from './searchDoc.js';
import { intentText, redactResumeText, resumeText, sourceHash, type IntentInput, type ResumeStrip } from './userText.js';

export const RETRIEVAL_WORK_KINDS = { jobIndex: 'job.index', userEmbed: 'user.embed' } as const;

/** Most job ids one `job.index` item carries: one embeddings request. */
export const JOB_INDEX_MAX_IDS = 96;
/** Items of a kind run in parallel within one drain batch. */
export const RETRIEVAL_CONCURRENCY = 4;

export interface JobIndexPayload {
  jobIds: string[];
}

export interface UserEmbedPayload {
  userId: string;
  market: string;
}

type Embed = (brand: BrandId, texts: readonly string[], options: EmbedOptions) => Promise<EmbedResult>;

// ── job.index ─────────────────────────────────────────────────────────────

export interface JobIndexDeps {
  repo: Pick<RetrievalRepo, 'loadIndexJobs' | 'writeSearchDoc' | 'jobEmbeddingMeta' | 'upsertJobEmbedding' | 'touchJobEmbeddings'>;
  embed: Embed;
  /** `jobContentHash` of features/match: the one definition of "the content a fit depends on". */
  contentHash: (row: Pick<IndexJobRow, 'title' | 'qualifications' | 'descriptionPlain' | 'skills'>) => string | Promise<string>;
  /** GoApply AI consent of the owner of a private import (platform/consent). */
  aiAllowed: (userId: string) => Promise<boolean>;
  /** The canonical skill vocabulary, when one is loaded (features/skills); null → the stored skill strings. */
  skillLabels?: () => Promise<SkillLabels | null>;
  env?: EnvSource;
}

export interface JobIndexOutcome {
  /** Jobs whose search document was written. */
  indexed: number;
  /** Vectors written. */
  embedded: number;
  /** Jobs whose stored vector was current. */
  unchanged: number;
  /** Why no vector was written for the rest, when the client was unavailable. */
  unavailable: string | null;
  /** Private imports left without a vector because their owner has not allowed AI. */
  withoutConsent: number;
}

/** A posting's text for language detection: the title and the head of what it asks for. */
function langSample(row: IndexJobRow): string {
  return `${row.title}\n${(row.qualifications || row.descriptionPlain || '').slice(0, 4000)}`;
}

const isPrivate = (row: IndexJobRow): boolean => row.visibility === 'private' && !!row.ownerUserId;

export async function indexJobs(payload: JobIndexPayload, deps: JobIndexDeps, meta: { requestId?: string } = {}): Promise<JobIndexOutcome> {
  const ids = [...new Set(payload.jobIds)];
  const rows = (await deps.repo.loadIndexJobs(ids)).filter((r) => !r.archivedAt);
  const outcome: JobIndexOutcome = { indexed: 0, embedded: 0, unchanged: 0, unavailable: null, withoutConsent: 0 };
  if (!rows.length) return outcome;

  const skillLabels = deps.skillLabels && rows.some((r) => r.skillIds?.length) ? await deps.skillLabels().catch(() => null) : null;
  const textDeps = { skillLabels };

  // 1. The lexical part: no model, always written.
  for (const row of rows) {
    await deps.repo.writeSearchDoc(row.id, { searchDoc: buildSearchDoc(row, textDeps), contentHash: await deps.contentHash(row), lang: detectLang(langSample(row)) });
    outcome.indexed += 1;
  }

  // 2. The vectors. One market per item (a batch never mixes brands: vectors never cross markets).
  const byMarket = new Map<string, IndexJobRow[]>();
  for (const row of rows) byMarket.set(row.market, [...(byMarket.get(row.market) ?? []), row]);
  for (const [market, marketRows] of byMarket) {
    const tag = writeModelTag(market, deps.env);
    if (!tag) {
      outcome.unavailable = 'no_key';
      continue;
    }
    const consent = new Map<string, boolean>();
    const eligible: IndexJobRow[] = [];
    for (const row of marketRows) {
      if (!isPrivate(row)) {
        eligible.push(row);
        continue;
      }
      const owner = row.ownerUserId!;
      if (!consent.has(owner)) consent.set(owner, await deps.aiAllowed(owner));
      if (consent.get(owner)) eligible.push(row);
      else outcome.withoutConsent += 1;
    }
    if (!eligible.length) continue;

    const stored = await deps.repo.jobEmbeddingMeta(eligible.map((r) => r.id));
    const cards = eligible.map((row) => {
      const text = buildCardText(row, textDeps);
      return { row, text, hash: cardHash(text) };
    });
    const current = cards.filter((c) => stored.get(c.row.id)?.model === tag && stored.get(c.row.id)?.contentHash === c.hash);
    const todo = cards.filter((c) => !current.includes(c) && c.text);
    if (current.length) {
      await deps.repo.touchJobEmbeddings(current.map((c) => c.row.id));
      outcome.unchanged += current.length;
    }
    if (!todo.length) continue;

    const result = await deps.embed(brandOfMarket(market), todo.map((c) => c.text), {
      purpose: 'job',
      // A private import's text came from its owner.
      carriesUserData: todo.some((c) => isPrivate(c.row)),
      requestId: meta.requestId ?? null,
    });
    if ('unavailable' in result) {
      outcome.unavailable = result.unavailable;
      logger.info('RETRIEVAL', 'no vectors written: the embeddings client is unavailable; the sweep embeds these rows later', { market, reason: result.unavailable, jobs: todo.length });
      continue;
    }
    if (result.vectors.length !== todo.length) throw new Error(`job.index: ${result.vectors.length} vectors for ${todo.length} texts`);
    for (let i = 0; i < todo.length; i += 1) {
      await deps.repo.upsertJobEmbedding(todo[i]!.row.id, market, result.model, todo[i]!.hash, result.vectors[i]!);
      outcome.embedded += 1;
    }
  }
  return outcome;
}

function parseJobIndexPayload(payload: unknown): JobIndexPayload {
  const ids = (payload as { jobIds?: unknown } | null)?.jobIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > JOB_INDEX_MAX_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    throw new PermanentWorkError(`job.index: invalid payload (jobIds must be 1 to ${JOB_INDEX_MAX_IDS} ids)`);
  }
  return { jobIds: ids as string[] };
}

// ── user.embed ────────────────────────────────────────────────────────────

/** What the two texts are built from. */
export interface UserTextSource {
  intent: IntentInput;
  /** The primary resume's parsed data; null when the person has no resume. */
  resumeParsed: unknown | null;
  /** The person's own names (removed from the resume text). */
  names: Array<string | null | undefined>;
}

export interface UserEmbedDeps {
  repo: Pick<RetrievalRepo, 'userEmbeddingMeta' | 'upsertUserEmbedding' | 'deleteUserEmbeddings' | 'deleteJobEmbeddingsOfOwner'>;
  embed: Embed;
  /**
   * GoApply "Use AI" consent, STRICT: `hasLiveConsent(userId, AI_CONSENT_TYPE)`.
   * True or false for a record that was read; THROWS when it could not be
   * read. (Not the fail-closed `aiAllowed`: its "no" here deletes vectors.)
   */
  aiAllowed: (userId: string) => Promise<boolean>;
  /** GoApply 个性化推荐: `hasLiveConsent(userId, 'personalized_recommendation')`, the feed's own rule. STRICT in the same way. */
  personalized: (userId: string) => Promise<boolean>;
  /** The person's inputs; null when the account is gone. */
  loadUser: (userId: string, market: string) => Promise<UserTextSource | null>;
  /** The scorer's PII strip for resume text. */
  strip: () => Promise<ResumeStrip>;
  /** The tag queries of the market filter on now (modelTag.ts). */
  queryTag: (market: string) => Promise<string | null>;
  env?: EnvSource;
}

export type UserEmbedOutcome =
  | { status: 'deleted'; reason: 'no_account' | 'no_ai_consent' | 'no_personalization'; rows: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'done'; embedded: UserVectorKind[]; unchanged: UserVectorKind[]; removed: UserVectorKind[] };

/**
 * May this person's profile and resume be embedded, and compared, on this
 * market? A definite answer only: a consent record that cannot be read makes
 * the dependency throw, and the error goes to the caller (which must neither
 * embed nor delete on it).
 */
export async function userVectorGate(userId: string, market: string, deps: Pick<UserEmbedDeps, 'aiAllowed' | 'personalized'>): Promise<'ok' | 'no_ai_consent' | 'no_personalization'> {
  if (market !== 'cn') return 'ok';
  if (!(await deps.aiAllowed(userId))) return 'no_ai_consent';
  if (!(await deps.personalized(userId))) return 'no_personalization';
  return 'ok';
}

export async function embedUser(payload: UserEmbedPayload, deps: UserEmbedDeps, meta: { requestId?: string } = {}): Promise<UserEmbedOutcome> {
  const { userId, market } = payload;
  // Throws when a consent record cannot be read: the item fails and the queue retries it. Nothing is deleted on a failed read.
  const gate = await userVectorGate(userId, market, deps);
  if (gate !== 'ok') {
    let rows = await deps.repo.deleteUserEmbeddings(userId, market);
    // A private import was embedded under the AI consent (see indexJobs): its vector goes with that consent.
    if (gate === 'no_ai_consent') rows += await deps.repo.deleteJobEmbeddingsOfOwner(userId, market);
    return { status: 'deleted', reason: gate, rows };
  }

  const source = await deps.loadUser(userId, market);
  if (!source) return { status: 'deleted', reason: 'no_account', rows: await deps.repo.deleteUserEmbeddings(userId, market) };

  const tag = writeModelTag(market, deps.env);
  if (!tag) return { status: 'unavailable', reason: 'no_key' };

  const texts: Record<UserVectorKind, string> = {
    intent: intentText(source.intent),
    resume: source.resumeParsed ? resumeText({ parsedData: source.resumeParsed }, { names: source.names, strip: await deps.strip() }) : '',
  };
  const stored = new Map((await deps.repo.userEmbeddingMeta(userId, market)).map((m) => [m.kind, m]));
  // While the market moves to another model, a vector of the model queries still use stays as long as its text is unchanged.
  const queryTag = await deps.queryTag(market);
  const kinds: UserVectorKind[] = ['intent', 'resume'];
  const removed = kinds.filter((k) => !texts[k] && stored.has(k));
  const unchanged = kinds.filter((k) => {
    const row = stored.get(k);
    if (!texts[k] || !row) return false;
    if (row.model === tag && row.sourceHash === sourceHash(texts[k], tag)) return true;
    return !!queryTag && queryTag !== tag && row.model === queryTag && row.sourceHash === sourceHash(texts[k], queryTag);
  });
  const todo = kinds.filter((k) => texts[k] && !unchanged.includes(k));

  if (removed.length) await deps.repo.deleteUserEmbeddings(userId, market, removed);
  if (!todo.length) return { status: 'done', embedded: [], unchanged, removed };

  const result = await deps.embed(brandOfMarket(market), todo.map((k) => texts[k]), { purpose: 'user', carriesUserData: true, userId, requestId: meta.requestId ?? null });
  if ('unavailable' in result) return { status: 'unavailable', reason: result.unavailable };
  if (result.vectors.length !== todo.length) throw new Error(`user.embed: ${result.vectors.length} vectors for ${todo.length} texts`);
  for (let i = 0; i < todo.length; i += 1) {
    await deps.repo.upsertUserEmbedding(userId, market, todo[i]!, result.model, sourceHash(texts[todo[i]!], result.model), result.vectors[i]!);
  }
  return { status: 'done', embedded: todo, unchanged, removed };
}

function parseUserEmbedPayload(item: LeasedWorkItem<unknown>): UserEmbedPayload {
  const p = item.payload as Partial<UserEmbedPayload> | null;
  const userId = typeof p?.userId === 'string' && p.userId ? p.userId : item.userId;
  const market = p?.market;
  if (!userId || (market !== 'intl' && market !== 'cn')) throw new PermanentWorkError('user.embed: invalid payload (userId and market are required)');
  // A person's vectors belong to the market of their own brand; an item of the other brand is a producer bug.
  if (brandOfMarket(market) !== item.brand) throw new PermanentWorkError(`user.embed: market ${market} does not belong to brand ${item.brand}`);
  return { userId, market };
}

function msToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5);
  return Math.max(60_000, next - now.getTime());
}

// ── Default dependencies (everything heavy is loaded on first use) ─────────

let jobDepsOverride: JobIndexDeps | null = null;
let userDepsOverride: UserEmbedDeps | null = null;

/** Test seam: replace the workers' dependencies (null restores the defaults). */
export function setRetrievalDepsForTests(deps: { jobIndex?: JobIndexDeps | null; userEmbed?: UserEmbedDeps | null }): void {
  if (deps.jobIndex !== undefined) jobDepsOverride = deps.jobIndex;
  if (deps.userEmbed !== undefined) userDepsOverride = deps.userEmbed;
}

const embedLazy: Embed = async (brand, texts, options) => (await import('../../platform/embeddings/index.js')).embedTexts(brand, texts, options);
const aiAllowedLazy = async (userId: string): Promise<boolean> => (await import('../../platform/consent/index.js')).aiAllowed(userId);

/**
 * The canonical skill vocabulary (features/skills, built in the same phase by
 * another bundle), read without a static import so this module compiles and
 * runs before and after that area exists. Null when it is absent or cannot be
 * loaded: the stored skill strings are used.
 */
export async function loadSkillLabels(specifier = '../skills/index.js'): Promise<SkillLabels | null> {
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    let holder: Record<string, unknown> = mod;
    if (typeof mod.loadVocabulary === 'function') {
      const loaded = (await (mod.loadVocabulary as () => unknown)()) as Record<string, unknown> | null | undefined;
      if (loaded && typeof loaded === 'object') holder = { ...mod, ...loaded };
    }
    if (typeof holder.label === 'function' && typeof holder.kindOf === 'function') return holder as unknown as SkillLabels;
    if (typeof holder.ready === 'function') await (holder.ready as () => Promise<void>)();
    const vocabulary = typeof holder.current === 'function' ? ((holder.current as () => unknown)() as Partial<SkillLabels> | null) : null;
    return vocabulary && typeof vocabulary.label === 'function' && typeof vocabulary.kindOf === 'function' ? (vocabulary as SkillLabels) : null;
  } catch {
    return null;
  }
}

export function defaultJobIndexDeps(): JobIndexDeps {
  return {
    repo: defaultRetrievalRepo,
    embed: embedLazy,
    // Loaded on first use: the match area's surface is not part of this module's start-up.
    contentHash: async (row) => (await import('../match/index.js')).jobContentHash(row),
    aiAllowed: aiAllowedLazy,
    skillLabels: () => loadSkillLabels(),
  };
}

/**
 * The scorer's own strip when the match area exports it; `redactResumeText`
 * otherwise, which is safe on its own: both drop every line that carries a
 * sensitive field (gender, birth date, 政治面貌, 籍贯, marital status, …) and
 * remove URLs, contact details, ids and the person's name. The text they get
 * is built from structured fields only.
 */
export async function defaultStrip(): Promise<ResumeStrip> {
  try {
    const match = (await import('../match/index.js')) as unknown as { stripResumeForScoring?: ResumeStrip };
    if (typeof match.stripResumeForScoring === 'function') return match.stripResumeForScoring;
  } catch {
    // fall through to the platform redactor
  }
  return redactResumeText;
}

export function defaultUserEmbedDeps(): UserEmbedDeps {
  return {
    repo: defaultRetrievalRepo,
    embed: embedLazy,
    // Strict on purpose: a "no" from these two deletes vectors, so a lookup error must throw (see UserEmbedDeps).
    aiAllowed: async (userId) => {
      const consent = await import('../../platform/consent/index.js');
      return consent.hasLiveConsent(userId, consent.AI_CONSENT_TYPE);
    },
    personalized: async (userId) => (await import('../../platform/consent/index.js')).hasLiveConsent(userId, 'personalized_recommendation'),
    loadUser: async (userId, market) => (await import('./userSource.js')).loadUserTextSource(userId, market),
    strip: defaultStrip,
    queryTag: (market) => currentModelTag(market),
  };
}

export const jobIndexWorker: WorkerDefinition<unknown> = {
  kind: RETRIEVAL_WORK_KINDS.jobIndex,
  concurrency: RETRIEVAL_CONCURRENCY,
  handler: async (item) => {
    const payload = parseJobIndexPayload(item.payload);
    await indexJobs(payload, jobDepsOverride ?? defaultJobIndexDeps(), { requestId: `job-index-${item.id}` });
  },
};

export const userEmbedWorker: WorkerDefinition<unknown> = {
  kind: RETRIEVAL_WORK_KINDS.userEmbed,
  concurrency: RETRIEVAL_CONCURRENCY,
  handler: async (item) => {
    const payload = parseUserEmbedPayload(item);
    const outcome = await embedUser(payload, userDepsOverride ?? defaultUserEmbedDeps(), { requestId: `user-embed-${item.id}` });
    // A SPENT daily budget: the item waits for the next UTC day without spending an attempt. (A budget counter that could not
    // be read is an EmbeddingsError from the client: the item fails and is retried with the normal backoff.)
    if (outcome.status === 'unavailable' && outcome.reason === 'budget') throw new DeferWorkError(msToNextUtcDay(new Date()), 'embedding budget spent for today');
  },
};

/** The retrieval workers; spread into the enrichment area's `workers` array. */
export const retrievalWorkers: WorkerDefinition<unknown>[] = [jobIndexWorker, userEmbedWorker];
