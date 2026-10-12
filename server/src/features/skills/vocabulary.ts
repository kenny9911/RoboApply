// server/src/features/skills/vocabulary.ts
//
// The vocabulary snapshot and its loader (SM-6; MARKET_TASK_PLAN 3.3).
//
//   buildVocabulary(records)   pure: records → a snapshot. Tests, the seed
//                              generator and the review tooling use it.
//   createVocabularyLoader()   reads RASkill through a repo, merges the rows
//                              over the committed seed and keeps the result
//                              for 10 minutes.
//   ready() / current()        the process-wide loader. `current()` is
//                              synchronous and never empty: before the first
//                              load, and whenever the database cannot be
//                              read, it is the committed seed.
//
// The estimate is synchronous and its preparer hook runs once per process
// (match/prepare.ts), so nothing calls `ready()` again later. `current()`
// therefore starts the refresh itself, in the background, when the snapshot is
// older than the cache time; the caller gets the snapshot it has and the next
// call gets the new one.
//
// Importing this file opens no database connection: the default repo imports
// the Prisma client inside its first read.

import { logger } from '../../services/LoggerService.js';
import { aliasKey, hasHan } from './keys.js';
import { phraseOfKey, phrasesOfName } from './phrase.js';
import { createPrismaSkillRepo, type SkillRepo, type SkillRow } from './repo.js';
import { SEED_DROPPED_KEYS, SEED_SKILLS } from './seed/index.js';
import { SKILL_KINDS, SKILL_STATUS_DROPPED, SKILL_STATUS_SEED, type AliasConflict, type SkillKind, type SkillRecord, type SkillSnapshot, type SkillVocabulary } from './types.js';

/** How long a loaded snapshot is used before the table is read again. */
export const VOCABULARY_TTL_MS = 10 * 60_000;
/** How long to wait after a failed read before trying again. */
export const VOCABULARY_RETRY_MS = 30_000;

type LabelScript = 'en' | 'zh' | 'zhHant';

/** Which label a locale reads. Taiwan, Hong Kong and Macau read the Traditional label, never the Simplified one. */
export function labelScriptOf(locale: string): LabelScript {
  const l = String(locale ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (/^zh-(tw|hk|mo|hant)\b/.test(l)) return 'zhHant';
  if (l === 'zh' || l.startsWith('zh-')) return 'zh';
  return 'en';
}

function uniq(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/** The id as a term ("relational_databases" → "relational databases"), so an id is always an alias of itself. */
function idAsTerm(id: string): string {
  return id.replace(/_/g, ' ');
}

export interface BuildVocabularyOptions {
  /** When the database rows were read (null: built from records only). */
  asOf?: Date | null;
  source?: 'seed' | 'database';
  /** Comparison keys of strings a reviewer dropped. */
  droppedKeys?: Iterable<string>;
}

/**
 * The mutable form of a snapshot. Only the write path of this module
 * (`rememberSkill`, `rememberAlias`) changes one after it is built.
 */
class Snapshot implements SkillSnapshot {
  readonly asOf: Date | null;
  readonly source: 'seed' | 'database';
  readonly conflicts: AliasConflict[] = [];
  private readonly records = new Map<string, SkillRecord>();
  private readonly keyToId = new Map<string, string>();
  private readonly keysById = new Map<string, Set<string>>();
  private readonly children = new Map<string, string[]>();
  private readonly dropped: Set<string>;
  /** The words of every name as a sentence writes them ("rest api") → the skill. Read by the text scan only. */
  private readonly phraseToId = new Map<string, string>();
  private phrasePrefixes: Set<string> | null = null;
  private longestPhrase = 0;

  constructor(records: readonly SkillRecord[], options: BuildVocabularyOptions) {
    this.asOf = options.asOf ?? null;
    this.source = options.source ?? 'seed';
    this.dropped = new Set(options.droppedKeys ?? []);
    // Reviewed skills claim before unreviewed ones, then by id: the result does not depend on the input order.
    const ordered = [...records].sort((a, b) => Number(b.status === 'reviewed') - Number(a.status === 'reviewed') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of ordered) {
      if (!r.id || this.records.has(r.id)) continue;
      this.records.set(r.id, { ...r, aliases: [...r.aliases], ...(r.aliasKeys ? { aliasKeys: [...r.aliasKeys] } : {}) });
      this.keysById.set(r.id, new Set());
    }
    // Labels first for every skill, so an alias of one skill never takes another skill's own name.
    for (const r of this.records.values()) for (const label of [r.labelEn, r.labelZh, r.labelZhHant]) if (label) this.claim(r.id, aliasKey(label));
    for (const r of this.records.values()) {
      for (const alias of r.aliases) this.claim(r.id, aliasKey(alias));
      for (const key of r.aliasKeys ?? []) this.claim(r.id, key);
    }
    for (const r of this.records.values()) this.claim(r.id, aliasKey(idAsTerm(r.id)), true);
    for (const r of this.records.values()) this.indexPhrases(r);
    this.linkChildren();
  }

  /** Give `key` to `id` unless another skill has it. `quiet`: the id's own key is a convenience, losing it is not a conflict. */
  private claim(id: string, key: string, quiet = false): boolean {
    if (!key) return false;
    const owner = this.keyToId.get(key);
    if (owner === id) return true;
    if (owner !== undefined) {
      if (!quiet) this.conflicts.push({ key, keptId: owner, lostId: id });
      return false;
    }
    this.keyToId.set(key, id);
    this.keysById.get(id)!.add(key);
    this.dropped.delete(key);
    return true;
  }

  /**
   * The phrases of the names `r` holds. A spelling gives its own words; a
   * stored key gives a phrase only when it has Chinese in it (phrase.ts). A
   * name another skill won is not indexed for this one.
   */
  private indexPhrases(r: SkillRecord): void {
    const own = (key: string) => !!key && this.keyToId.get(key) === r.id;
    for (const name of [r.labelEn, r.labelZh, r.labelZhHant, ...r.aliases, idAsTerm(r.id)]) {
      if (!name || !own(aliasKey(name))) continue;
      for (const phrase of phrasesOfName(name)) this.setPhrase(phrase, r.id);
    }
    for (const key of r.aliasKeys ?? []) if (own(key)) this.setKeyPhrase(key, r.id);
  }

  private setKeyPhrase(key: string, id: string): void {
    const phrase = phraseOfKey(key);
    if (phrase) this.setPhrase(phrase, id);
  }

  private setPhrase(phrase: string, id: string): void {
    if (this.phraseToId.has(phrase)) return;
    this.phraseToId.set(phrase, id);
    if (phrase.length > this.longestPhrase) this.longestPhrase = phrase.length;
    this.phrasePrefixes = null;
  }

  private linkChildren(): void {
    this.children.clear();
    for (const r of this.records.values()) {
      const parent = this.parentOf(r.id);
      if (!parent) continue;
      const list = this.children.get(parent) ?? [];
      list.push(r.id);
      this.children.set(parent, list);
    }
    for (const list of this.children.values()) list.sort();
  }

  get size(): number {
    return this.records.size;
  }

  idOf(term: string): string | null {
    return this.idOfKey(aliasKey(String(term ?? '')));
  }

  idOfKey(key: string): string | null {
    return (key && this.keyToId.get(key)) || null;
  }

  idOfPhrase(phrase: string): string | null {
    return (phrase && this.phraseToId.get(phrase)) || null;
  }

  kindOf(id: string): SkillKind | null {
    return this.records.get(id)?.kind ?? null;
  }

  reviewed(id: string): boolean {
    return this.records.get(id)?.status === 'reviewed';
  }

  label(id: string, locale: string): string {
    const r = this.records.get(id);
    if (!r) return id;
    const script = labelScriptOf(locale);
    if (script === 'zh') return r.labelZh || r.labelEn;
    // An unreviewed skill made from a Chinese posting has that string as its English label. It is returned for
    // Taiwan only as labelZhHant, that is, when it was written in Traditional script; else '' (show the posting's own string).
    if (script === 'zhHant') return r.labelZhHant || (hasHan(r.labelEn) ? '' : r.labelEn);
    return r.labelEn;
  }

  /** The broader skill, when it exists and following it never comes back to `id` (a loop in reviewed data is ignored, not followed). */
  parentOf(id: string): string | null {
    const parent = this.records.get(id)?.parentId ?? null;
    if (!parent || parent === id || !this.records.has(parent)) return null;
    const seen = new Set([id]);
    for (let at: string | null = parent; at; at = this.records.get(at)?.parentId ?? null) {
      if (seen.has(at)) return null;
      seen.add(at);
      if (!this.records.has(at)) break;
    }
    return parent;
  }

  childrenOf(id: string): string[] {
    return [...(this.children.get(id) ?? [])];
  }

  record(id: string): SkillRecord | null {
    const r = this.records.get(id);
    return r ? { ...r, aliases: [...r.aliases], ...(r.aliasKeys ? { aliasKeys: [...r.aliasKeys] } : {}) } : null;
  }

  ids(): string[] {
    return [...this.records.keys()].sort();
  }

  keysOf(id: string): string[] {
    return [...(this.keysById.get(id) ?? [])].sort();
  }

  isDropped(term: string): boolean {
    const key = aliasKey(String(term ?? ''));
    return !!key && this.dropped.has(key);
  }

  everydayWord(id: string): boolean {
    return this.records.get(id)?.everydayWord === true;
  }

  /** Is `prefix` the start of some phrase? The text scan stops extending a window when it is not. */
  hasPhrasePrefix(prefix: string): boolean {
    if (prefix.length > this.longestPhrase) return false;
    if (!this.phrasePrefixes) {
      const set = new Set<string>();
      for (const phrase of this.phraseToId.keys()) for (let i = 1; i <= phrase.length; i++) set.add(phrase.slice(0, i));
      this.phrasePrefixes = set;
    }
    return this.phrasePrefixes.has(prefix);
  }

  /** Write path: a skill created a moment ago is known at once. False when the id or its key is taken. */
  add(record: SkillRecord): boolean {
    if (!record.id || this.records.has(record.id)) return false;
    this.records.set(record.id, { ...record, aliases: [...record.aliases], ...(record.aliasKeys ? { aliasKeys: [...record.aliasKeys] } : {}) });
    this.keysById.set(record.id, new Set());
    for (const label of [record.labelEn, record.labelZh, record.labelZhHant]) if (label) this.claim(record.id, aliasKey(label));
    for (const alias of record.aliases) this.claim(record.id, aliasKey(alias));
    for (const key of record.aliasKeys ?? []) this.claim(record.id, key);
    this.claim(record.id, aliasKey(idAsTerm(record.id)), true);
    this.indexPhrases(this.records.get(record.id)!);
    this.linkChildren();
    return true;
  }

  /** Write path: an alias learned a moment ago is exact from now on. False when another skill has the key. */
  addAliasKey(id: string, key: string): boolean {
    const r = this.records.get(id);
    if (!r || !key) return false;
    const before = this.conflicts.length;
    const ok = this.claim(id, key);
    this.conflicts.length = before; // a refused learned alias is not a data conflict
    if (ok) {
      r.aliasKeys = uniq([...(r.aliasKeys ?? []), key]);
      this.setKeyPhrase(key, id);
    }
    return ok;
  }
}

/** Records → a snapshot. Pure and deterministic: the same records in any order give the same lookups. */
export function buildVocabulary(records: readonly SkillRecord[], options: BuildVocabularyOptions = {}): SkillSnapshot {
  return new Snapshot(records, options);
}

/** A skill created a moment ago by the write path: known to `vocabulary` at once. */
export function rememberSkill(vocabulary: SkillVocabulary, record: SkillRecord): boolean {
  return vocabulary instanceof Snapshot ? vocabulary.add(record) : false;
}

/** An alias key learned a moment ago by the write path: exact in `vocabulary` from now on. */
export function rememberAlias(vocabulary: SkillVocabulary, skillId: string, key: string): boolean {
  return vocabulary instanceof Snapshot ? vocabulary.addAliasKey(skillId, key) : false;
}

/** Is `prefix` the start of a phrase of `vocabulary`? True for a vocabulary that cannot say (the scan then tries every window). */
export function hasPhrasePrefix(vocabulary: SkillVocabulary, prefix: string): boolean {
  return vocabulary instanceof Snapshot ? vocabulary.hasPhrasePrefix(prefix) : true;
}

// ── Database rows over the seed ───────────────────────────────────────────

function kindOfRow(kind: string, fallback: SkillKind): SkillKind {
  return (SKILL_KINDS as readonly string[]).includes(kind) ? (kind as SkillKind) : fallback;
}

export interface MergeOverSeedOptions {
  /** Comparison keys the committed seed lists as dropped (seed/index.ts SEED_DROPPED_KEYS for the committed seed). */
  seedDroppedKeys?: Iterable<string>;
}

/**
 * The records of a vocabulary: every seed skill, with the database row over
 * it where one exists, plus every skill that exists only in the database.
 *
 * A row is a review decision only when its status is `reviewed`:
 *   · A REVIEWED row's kind, parent, status and identifiers win (the reviewed
 *     table is the truth). A label the row lacks is taken from the seed; a
 *     label is never removed by a row. Alias keys are the union, so an alias
 *     added to the seed in a release applies at once.
 *   · A row of status `seed` (the copy an automatic step made) and an
 *     UNREVIEWED row that carries the id of a seed skill decide nothing: the
 *     skill's kind, labels, parent and status are the seed's, so a later
 *     change to the seed applies. Only what the row adds counts: alias keys
 *     and ESCO / O*NET identifiers.
 *   · A `seed` row whose skill the seed no longer has is not a skill.
 *   · A row with status `dropped` removes the skill and blocks its keys.
 *   · An unreviewed row whose string the seed lists as dropped is not a skill
 *     either: a reviewer's `drop` reaches every environment through the seed.
 */
export function mergeOverSeed(seed: readonly SkillRecord[], rows: readonly SkillRow[], options: MergeOverSeedOptions = {}): { records: SkillRecord[]; droppedKeys: string[] } {
  const byId = new Map(seed.map((r) => [r.id, r] as const));
  const seedDropped = new Set(options.seedDroppedKeys ?? []);
  const droppedKeys: string[] = [...seedDropped];
  const out = new Map<string, SkillRecord>(byId);
  for (const row of rows) {
    if (!row.id) continue;
    const base = byId.get(row.id);
    if (row.status === SKILL_STATUS_DROPPED) {
      out.delete(row.id);
      droppedKeys.push(...row.aliases, aliasKey(row.labelEn), aliasKey(idAsTerm(row.id)));
      continue;
    }
    const reviewed = row.status === 'reviewed';
    if (base && !reviewed) {
      const keys = uniq([...(base.aliasKeys ?? []), ...row.aliases]);
      out.set(row.id, { ...base, aliases: [...base.aliases], ...(keys.length ? { aliasKeys: keys } : {}), esco: row.esco ?? base.esco, onet: row.onet ?? base.onet });
      continue;
    }
    if (!base && row.status === SKILL_STATUS_SEED) continue;
    if (!base && !reviewed && (seedDropped.has(row.id) || (row.aliases.length > 0 && row.aliases.every((key) => seedDropped.has(key))))) {
      droppedKeys.push(...row.aliases);
      continue;
    }
    out.set(row.id, {
      id: row.id,
      kind: kindOfRow(row.kind, base?.kind ?? 'hard'),
      labelEn: row.labelEn || base?.labelEn || row.id,
      labelZh: row.labelZh ?? base?.labelZh ?? null,
      labelZhHant: row.labelZhHant ?? base?.labelZhHant ?? null,
      aliases: [...(base?.aliases ?? [])],
      aliasKeys: uniq([...(base?.aliasKeys ?? []), ...row.aliases]),
      parentId: row.parentId ?? null,
      esco: row.esco ?? base?.esco ?? null,
      onet: row.onet ?? base?.onet ?? null,
      status: reviewed ? 'reviewed' : 'unreviewed',
      ...(base?.everydayWord ? { everydayWord: true } : {}),
    });
  }
  return { records: [...out.values()], droppedKeys: droppedKeys.filter(Boolean) };
}

// ── Loader ────────────────────────────────────────────────────────────────

export interface VocabularyLoaderOptions {
  /** Where RASkill is read from. Null: the seed only, no read at all. */
  repo?: Pick<SkillRepo, 'list'> | null;
  /** Default: the committed seed, with the keys it lists as dropped. */
  seed?: readonly SkillRecord[];
  /** Keys the seed lists as dropped. Default: those of the committed seed when `seed` is not given, else none. */
  seedDroppedKeys?: readonly string[];
  ttlMs?: number;
  retryMs?: number;
  now?: () => number;
  /** Called when the table cannot be read (the loader keeps the snapshot it has). */
  onError?: (err: unknown) => void;
}

export interface VocabularyLoader {
  /** Resolves when a snapshot read from the table is in place, or the read failed and the last good snapshot (at worst the seed) stays. Never rejects. */
  ready(): Promise<void>;
  /** The snapshot, synchronously. Never empty. Starts a background refresh when the snapshot is older than the cache time. */
  current(): SkillSnapshot;
  /** Read the table now, whatever the cache says. */
  refresh(): Promise<SkillSnapshot>;
}

export function createVocabularyLoader(options: VocabularyLoaderOptions = {}): VocabularyLoader {
  const seed = options.seed ?? SEED_SKILLS;
  const seedDroppedKeys = options.seedDroppedKeys ?? (options.seed ? [] : SEED_DROPPED_KEYS);
  const ttlMs = options.ttlMs ?? VOCABULARY_TTL_MS;
  const retryMs = options.retryMs ?? VOCABULARY_RETRY_MS;
  const now = options.now ?? Date.now;
  const repo = options.repo === undefined ? createPrismaSkillRepo() : options.repo;

  let snapshot: SkillSnapshot = buildVocabulary(seed, { droppedKeys: seedDroppedKeys });
  /** When the next read is due; 0 = never read. */
  let dueAt = 0;
  let running: Promise<void> | null = null;

  function load(): Promise<void> {
    if (running) return running;
    if (!repo) {
      dueAt = Number.POSITIVE_INFINITY;
      return Promise.resolve();
    }
    running = Promise.resolve()
      .then(() => repo.list())
      .then((rows) => {
        const at = now();
        const merged = mergeOverSeed(seed, rows, { seedDroppedKeys });
        snapshot = buildVocabulary(merged.records, { asOf: new Date(at), source: 'database', droppedKeys: merged.droppedKeys });
        dueAt = at + ttlMs;
      })
      // One catch for the read AND for building the snapshot: a row that breaks the merge must not reject `ready()`.
      .catch((err: unknown) => {
        // Keep what we have (at worst the seed) and try again a little later.
        dueAt = now() + retryMs;
        try {
          options.onError?.(err);
        } catch {
          // A reporter that throws must not reject `ready()` either.
        }
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    ready() {
      return now() >= dueAt ? load() : (running ?? Promise.resolve());
    },
    current() {
      if (dueAt !== 0 && now() >= dueAt && !running) void load();
      return snapshot;
    },
    async refresh() {
      if (running) await running;
      dueAt = 0;
      await load();
      return snapshot;
    },
  };
}

// ── The process-wide vocabulary ───────────────────────────────────────────

function logLoadFailure(err: unknown): void {
  logger.warn('SKILL_VOCABULARY', 'RASkill could not be read; using the last loaded vocabulary (at worst the committed seed)', {
    error: err instanceof Error ? err.message : String(err),
  });
}

let loader: VocabularyLoader | null = null;
let pinned: SkillSnapshot | null = null;

function theLoader(): VocabularyLoader {
  loader ??= createVocabularyLoader({ onError: logLoadFailure });
  return loader;
}

/**
 * Load the vocabulary (RASkill over the committed seed) and return it. With
 * `repo` the process-wide loader reads through that repo from now on; with
 * `force` the table is read even when the cache is fresh.
 */
export async function loadVocabulary(options: { repo?: Pick<SkillRepo, 'list'> | null; force?: boolean } = {}): Promise<SkillSnapshot> {
  if (pinned) return pinned;
  if (options.repo !== undefined) loader = createVocabularyLoader({ repo: options.repo, onError: logLoadFailure });
  if (options.force) return theLoader().refresh();
  await theLoader().ready();
  return theLoader().current();
}

/** Await this once before the first synchronous read (the match preparer does). Never rejects. */
export function ready(): Promise<void> {
  return pinned ? Promise.resolve() : theLoader().ready();
}

/** The vocabulary, synchronously. The committed seed until the table has been read. */
export function current(): SkillSnapshot {
  return pinned ?? theLoader().current();
}

/**
 * Test seam: pin the process-wide vocabulary to a fixture (records or a built
 * vocabulary), or pass null to go back to the loader. While pinned nothing
 * reads a database.
 */
export function setVocabularyForTests(vocabulary: SkillSnapshot | readonly SkillRecord[] | null): void {
  pinned = vocabulary === null ? null : Array.isArray(vocabulary) ? buildVocabulary(vocabulary as readonly SkillRecord[]) : (vocabulary as SkillSnapshot);
}

/** Test seam: forget the process-wide loader and any pinned fixture. */
export function resetVocabularyForTests(): void {
  loader = null;
  pinned = null;
}
