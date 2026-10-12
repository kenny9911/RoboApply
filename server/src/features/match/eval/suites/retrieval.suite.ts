// server/src/features/match/eval/suites/retrieval.suite.ts
//
// Retrieval layer (MARKET_STRATEGY 2.6; SM-7): Recall@200 of the postings a
// persona should see (graded 2 or 3), for the recency-only list and for the
// fused list of the three legs. Gate: fused ≥ recency-only + 15 points on the
// mean, and no persona more than 5 points below its recency-only value.
//
// What runs. Nothing here is a copy of the feed: the suite builds the feed's
// own statements with the feed's own builders (feed/sql.ts `retrievalSql`,
// feed/hybridSql.ts `recencyLegSql`, `lexicalLegSql`, `denseLegSql`), runs them
// on the in-memory twin the feed's tests use (feed/testkit.ts `FakeFeedRepo`:
// recency by posted date; lexical by the segmented tokens with a
// ts_rank_cd-like count; dense by cosine over the stored vectors), and fuses
// the legs with the function the feed fuses with (feed/ranking.ts
// `fuseByReciprocalRank`). The search document and the embedded card text of a
// posting, and the text embedded for a person, are built by features/retrieval
// (`buildSearchDoc`, `buildCardText`, `resumeText`); the lexical query of a
// person is the feed's `profileQueryText` (feed/hybridSql.ts) through retrieval `toTsQuery`. All
// of it is loaded by path at run time (seams.ts), never imported statically.
//
// The corpus is the synthetic postings of one market, with no filter: the
// question is which of the postings a person should see are among the 200
// candidates when their search does not already name the role. (Under the
// persona's own Role chip the synthetic corpus holds a handful of rows, every
// leg returns all of them and there is nothing to measure.)
//
// Career changers are measured and printed on their own rows
// (`recall_at_200_recency`, `recall_at_200_fused`, subset `career_changer`) and
// are not part of the gated values: their labels follow the role they WANT,
// which reaches matching only through a Role chip (invariant 2), and this
// suite runs with no filter.
//
// Vectors. `fixtures/retrieval/vectors.<market>.json` holds real embeddings of
// the synthetic texts, recorded by a live run (below) and committed, so CI
// needs no network. Until that file exists, or for a text it does not cover,
// the suite uses PROXY VECTORS: a deterministic hashed bag of the text's
// tokens. A proxy is not an embedding model, so a run on proxy vectors is
// printed with the note "proxy vectors" and status `no_fixture`: it is never
// held against the gate and never fails the command.
//
// Live mode (`EVAL_LIVE=1 npm run eval:match -- --live`, the owner's step):
//   1. the synthetic texts are embedded with the market's own embeddings
//      settings (`embedTexts`; job and resume texts of synthetic people, so no
//      user data) and written to `fixtures/retrieval/vectors.<market>.json`;
//      texts already recorded with the same model are not embedded again;
//   2. latency: the feed's first-window statements are timed read-only on the
//      real index for every persona (`feed_p95_ms`, scope `live`; gate: no
//      worse than the stored baseline + 150 ms). With FEED_HYBRID=off the
//      single recency statement is timed, which is how the baseline of "today"
//      is written (`FEED_HYBRID=off … --live --write-baseline`).
// Every dependency that touches the network or a database is injected, so the
// tests run this file with fakes.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '../../../../generated/prisma/client.js';
import { loadMarketFixtures, type MarketFixtures } from '../fixtures/load.js';
import type { Persona, Posting } from '../fixtures/schema.js';
import { CAREER_CHANGER_SUBSET, type GateLayer } from '../gates.js';
import { loadSeam } from '../seams.js';
import { notBuiltOrThrow, unmeasured, type SuiteContext, type SuiteMarket, type SuiteMeasure } from '../suite.js';
import { EVAL_NOW } from '../world.js';

export const name = 'retrieval';
export const layer: GateLayer = 'retrieval';

export const RECALL_K = 200;
export const VECTOR_DIMENSIONS = 1024;
const DAY_MS = 86_400_000;
const F = 'server/src/features';

export const PROXY_NOTE =
  'proxy vectors (a hashed bag of tokens, not an embedding model): printed for orientation, never held against the gate. Record real vectors with EVAL_LIVE=1 npm run eval:match -- --live';
/** Said on every row that was measured on proxy vectors but is not a gated row. */
const ON_PROXY = ' Measured on proxy vectors.';
export const CAREER_CHANGER_NOTE =
  'career changers: the labels follow the role the person wants, which reaches matching only through a Role chip (invariant 2), and this suite runs with no filter. Reported, not gated.';
export const LATENCY_OFFLINE_NOTE = 'the first-window statements are timed on the real index, read-only, under --live only';
export const SUBSET_NOTE = 'Recall@200 of the retrieval suite per language subset (no filter, career changers left out). Reported for the language comparison, not gated.';

const METRICS = ['recall_at_200_recency', 'recall_at_200_hybrid', 'recall_at_200_worst_persona_delta'] as const;
const SUBSETS = ['en', 'zh-TW', 'zh-CN', 'cross'] as const;

// ── What the suite loads from the code under test ─────────────────────────

interface SqlLike {
  text: string;
  values: unknown[];
}
type Sql = Prisma.Sql;

interface FeedRowLike {
  id: string;
  postedAt: Date | null;
}

interface FakeRepo {
  rows: unknown[];
  searchDocs: Map<string, string>;
  vectors: Map<string, number[]>;
  vectorModel: string;
  queryRows(sql: Sql): Promise<FeedRowLike[]>;
}

interface Code {
  FakeFeedRepo: new () => FakeRepo;
  feedRow: (over: Record<string, unknown>) => unknown;
  retrievalSql: (input: Record<string, unknown>) => Sql;
  recencyLegSql: (input: Record<string, unknown>) => Sql;
  lexicalLegSql: (input: Record<string, unknown>, tsQuery: string) => Sql;
  denseLegSql: (input: Record<string, unknown>, vectorLiteral: string, modelTag: string) => Sql;
  fuseByReciprocalRank: (legs: Array<readonly string[] | null>, opts: { k?: number; cap?: number; newer?: (a: string, b: string) => number }) => Array<{ id: string; score: number }>;
  profileQueryText: (user: { recentTitle: string | null; evidenceRoleIds: string[]; skills: string[] }, market: string) => string | null;
  limits: { legLimit: number; rrfK: number; retrievalLimit: number; firstWindowDays: number; widenWindowDays: number; widenBelowRows: number; maxAgeDays: number };
  buildSearchDoc: (row: Record<string, unknown>) => string;
  buildCardText: (row: Record<string, unknown>) => string;
  resumeText: (resume: { parsedData: unknown }, options: { names: string[]; strip: unknown }) => string;
  redactResumeText: unknown;
  segmentForSearch: (text: string) => string[];
  toTsQuery: (text: string | null) => string | null;
  vectorLiteral: (vector: readonly number[]) => string;
}

/** Every piece of the feed and of the retrieval area the suite runs. `SeamMissing` when one is absent. */
export async function loadCode(): Promise<Code> {
  const [FakeFeedRepo, feedRow, retrievalSql, recencyLegSql, lexicalLegSql, denseLegSql, fuseByReciprocalRank, profileQueryText, limits, buildSearchDoc, buildCardText, resumeText, redactResumeText, segmentForSearch, toTsQuery, vectorLiteral] =
    await Promise.all([
      loadSeam<Code['FakeFeedRepo']>(`${F}/feed/testkit.ts#FakeFeedRepo`),
      loadSeam<Code['feedRow']>(`${F}/feed/testkit.ts#feedRow`),
      loadSeam<Code['retrievalSql']>(`${F}/feed/sql.ts#retrievalSql`),
      loadSeam<Code['recencyLegSql']>(`${F}/feed/hybridSql.ts#recencyLegSql`),
      loadSeam<Code['lexicalLegSql']>(`${F}/feed/hybridSql.ts#lexicalLegSql`),
      loadSeam<Code['denseLegSql']>(`${F}/feed/hybridSql.ts#denseLegSql`),
      loadSeam<Code['fuseByReciprocalRank']>(`${F}/feed/ranking.ts#fuseByReciprocalRank`),
      loadSeam<Code['profileQueryText']>(`${F}/feed/hybridSql.ts#profileQueryText`),
      loadSeam<Code['limits']>(`${F}/feed/contract.ts#FEED_LIMITS`),
      loadSeam<Code['buildSearchDoc']>(`${F}/retrieval/index.ts#buildSearchDoc`),
      loadSeam<Code['buildCardText']>(`${F}/retrieval/index.ts#buildCardText`),
      loadSeam<Code['resumeText']>(`${F}/retrieval/index.ts#resumeText`),
      loadSeam<unknown>(`${F}/retrieval/index.ts#redactResumeText`),
      loadSeam<Code['segmentForSearch']>(`${F}/retrieval/index.ts#segmentForSearch`),
      loadSeam<Code['toTsQuery']>(`${F}/retrieval/index.ts#toTsQuery`),
      loadSeam<Code['vectorLiteral']>(`${F}/retrieval/index.ts#vectorLiteral`),
    ]);
  return { FakeFeedRepo, feedRow, retrievalSql, recencyLegSql, lexicalLegSql, denseLegSql, fuseByReciprocalRank, profileQueryText, limits, buildSearchDoc, buildCardText, resumeText, redactResumeText, segmentForSearch, toTsQuery, vectorLiteral };
}

// ── The synthetic texts ───────────────────────────────────────────────────

/** A synthetic posting as the columns indexing reads (retrieval `IndexJobRow`). */
export function indexRowOf(p: Posting): Record<string, unknown> {
  return {
    id: p.id,
    market: p.market,
    visibility: 'public',
    ownerUserId: null,
    title: p.title,
    primaryTaxonomyId: p.roleId,
    seniority: p.level,
    skills: p.skills.map((s) => s.name),
    skillsDetail: p.skills.map((s) => ({ skill: s.name, kind: s.kind, required: s.required })),
    skillIds: [],
    summary: null,
    qualifications: p.qualifications,
    descriptionPlain: p.description,
    archivedAt: null,
  };
}

/** A synthetic posting as a row of the feed's list (public, open, with a link, from an aggregator). */
export function feedRowOf(p: Posting, now: Date): Record<string, unknown> {
  // A fixed minute inside the day, from the id, so two postings of one day are not tied on the date.
  const minute = parseInt(createHash('sha1').update(p.id).digest('hex').slice(0, 6), 16) % 1440;
  const postedAt = new Date(now.getTime() - p.postedDaysAgo * DAY_MS - minute * 60_000);
  return {
    id: p.id,
    market: p.market,
    title: p.title,
    titleNormalized: p.title.toLowerCase(),
    companyName: p.companyName,
    companyNameNormalized: p.companyName.toLowerCase(),
    taxonomyIds: [p.categoryId, p.groupId, p.roleId],
    primaryTaxonomyId: p.roleId,
    seniority: p.level,
    skills: p.skills.map((s) => s.name.toLowerCase()),
    skillsDetail: p.skills.map((s) => ({ skill: s.name, kind: s.kind, required: s.required })),
    workModel: p.workModel,
    remoteScope: p.remoteScope,
    location: p.location.text,
    locationCity: p.location.city,
    locationCountry: p.location.country,
    employmentType: p.employmentType,
    postedAt,
    firstSeenAt: postedAt,
    lastSeenAt: now,
    applyUrl: `https://jobs.example.test/apply/${p.id}`,
    sourceUrl: `https://jobs.example.test/posting/${p.id}`,
    sourceBoard: 'activejobs',
  };
}

/** The parsed resume of a persona, as `personaResume` of world.ts stores it. */
function parsedResumeOf(p: Persona): Record<string, unknown> {
  return { skills: p.skills, experience: p.experience.map((e) => ({ role: e.title, company: e.company })) };
}

/** The text production embeds for a person: the last two titles, the skills and the summary of the primary resume. */
export function personaTextOf(p: Persona, code: Pick<Code, 'resumeText' | 'redactResumeText'>): string {
  return code.resumeText({ parsedData: parsedResumeOf(p) }, { names: [], strip: code.redactResumeText }) || [...p.recentTitles, ...p.skills].join('\n');
}

/** The lexical query of a person with no query text: the feed's own profile query. */
export function personaQueryOf(p: Persona, code: Pick<Code, 'profileQueryText' | 'toTsQuery'>): string | null {
  return code.toTsQuery(code.profileQueryText({ recentTitle: p.recentTitles[0] ?? null, evidenceRoleIds: [p.roleId], skills: p.skills }, p.market));
}

// ── Vectors: recorded, else proxy ─────────────────────────────────────────

export const textHash = (text: string): string => createHash('sha1').update(text).digest('hex');

function fnv1a(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A deterministic stand-in for an embedding: every token of the text adds +1
 * or −1 at a hashed position of a 1024-number vector. Two texts that share
 * tokens point the same way; it knows nothing about meaning. Never all zeros.
 */
export function proxyVector(text: string, segment: (text: string) => string[]): number[] {
  const v = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const token of segment(text)) {
    const h = fnv1a(token);
    const at = h % VECTOR_DIMENSIONS;
    v[at] = v[at]! + ((h >>> 12) & 1 ? 1 : -1);
  }
  if (!v.some((n) => n !== 0)) v[0] = 1;
  return v;
}

export const VECTORS_FILE = (market: SuiteMarket): string => `vectors.${market}.json`;

/** `fixtures/retrieval/vectors.<market>.json`. Vectors are little-endian float32, base64. */
export interface VectorsFile {
  _synthetic: true;
  _generatedBy: string;
  market: SuiteMarket;
  /** The model tag of every vector in the file (`<model>@1024`). */
  model: string;
  dimensions: number;
  encoding: 'f32le-base64';
  recordedAt: string;
  /** id → { the sha1 of the text that was embedded, the vector }. */
  postings: Record<string, { hash: string; v: string }>;
  personas: Record<string, { hash: string; v: string }>;
}

export function encodeVector(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

export function decodeVector(text: string): number[] | null {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== VECTOR_DIMENSIONS * 4) return null;
  const out = Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, VECTOR_DIMENSIONS));
  return out.every((n) => Number.isFinite(n)) && out.some((n) => n !== 0) ? out : null;
}

export function readVectorsFile(dir: string, market: SuiteMarket): VectorsFile | null {
  const file = path.join(dir, VECTORS_FILE(market));
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VectorsFile>;
  if (parsed._synthetic !== true || parsed.market !== market || parsed.dimensions !== VECTOR_DIMENSIONS || parsed.encoding !== 'f32le-base64' || typeof parsed.model !== 'string' || !parsed.postings || !parsed.personas) {
    throw new Error(`fixture retrieval/${VECTORS_FILE(market)} does not have the recorded-vectors shape`);
  }
  return parsed as VectorsFile;
}

interface Texts {
  postings: Map<string, string>;
  personas: Map<string, string>;
}

interface Vectors {
  postings: Map<string, number[]>;
  personas: Map<string, number[]>;
  /** `recorded`: every vector is a recorded embedding of the text as it is now. Otherwise the run is on proxy vectors. */
  kind: 'recorded' | 'proxy';
  model: string;
  /** How many texts had no recorded vector (0 when recorded). */
  missing: number;
}

export const PROXY_MODEL = 'proxy/hashed-bag-of-tokens@1024';

/**
 * The vectors of a run. Recorded vectors are used only when the file covers
 * EVERY text as it is now (a regenerated fixture text has another hash): a
 * run never mixes an embedding model with the proxy, the two are not
 * comparable.
 */
export function vectorsFor(texts: Texts, file: VectorsFile | null, segment: (text: string) => string[]): Vectors {
  if (file) {
    const read = (source: Record<string, { hash: string; v: string }>, wanted: Map<string, string>) => {
      const out = new Map<string, number[]>();
      for (const [id, text] of wanted) {
        const entry = source[id];
        const vector = entry && entry.hash === textHash(text) ? decodeVector(entry.v) : null;
        if (vector) out.set(id, vector);
      }
      return out;
    };
    const postings = read(file.postings, texts.postings);
    const personas = read(file.personas, texts.personas);
    const missing = texts.postings.size - postings.size + (texts.personas.size - personas.size);
    if (missing === 0) return { postings, personas, kind: 'recorded', model: file.model, missing: 0 };
    const proxy = vectorsFor(texts, null, segment);
    return { ...proxy, missing };
  }
  const make = (wanted: Map<string, string>) => new Map([...wanted].map(([id, text]) => [id, proxyVector(text, segment)]));
  return { postings: make(texts.postings), personas: make(texts.personas), kind: 'proxy', model: PROXY_MODEL, missing: texts.postings.size + texts.personas.size };
}

// ── The legs, in memory, through the feed's own statements ────────────────

export interface RetrievalWorld {
  market: SuiteMarket;
  now: Date;
  code: Code;
  repo: FakeRepo;
  texts: Texts;
  vectors: Vectors;
  postedAt: Map<string, number>;
}

export function textsOf(fx: Pick<MarketFixtures, 'personas' | 'postings'>, code: Code): Texts {
  return {
    postings: new Map(fx.postings.map((p) => [p.id, code.buildCardText(indexRowOf(p))])),
    personas: new Map(fx.personas.map((p) => [p.id, personaTextOf(p, code)])),
  };
}

export function buildWorld(fx: Pick<MarketFixtures, 'market' | 'personas' | 'postings'>, code: Code, file: VectorsFile | null, now: Date = EVAL_NOW): RetrievalWorld {
  const repo = new code.FakeFeedRepo();
  const texts = textsOf(fx, code);
  const vectors = vectorsFor(texts, file, code.segmentForSearch);
  const postedAt = new Map<string, number>();
  for (const p of fx.postings) {
    const row = code.feedRow(feedRowOf(p, now)) as FeedRowLike;
    repo.rows.push(row);
    postedAt.set(p.id, row.postedAt?.getTime() ?? 0);
    repo.searchDocs.set(p.id, code.buildSearchDoc(indexRowOf(p)));
    const vector = vectors.postings.get(p.id);
    if (vector) repo.vectors.set(p.id, vector);
  }
  repo.vectorModel = vectors.model;
  return { market: fx.market, now, code, repo, texts, vectors, postedAt };
}

export interface PersonaRetrieval {
  /** The newest 200 of the whole list: today's retrieval. */
  recencyOnly: string[];
  recency: string[];
  lexical: string[];
  dense: string[];
  /** The fused union, best first, cut at the feed's cap. */
  fused: string[];
}

const idsOf = (rows: FeedRowLike[]): string[] => rows.map((r) => r.id);

/** The legs for one persona: the statements the feed builds, with no filter, on the in-memory rows. */
export async function retrieveFor(world: RetrievalWorld, persona: Persona): Promise<PersonaRetrieval> {
  const { code, repo, now } = world;
  const L = code.limits;
  const scope = { market: world.market, userId: null, now, publicOnly: true, ignoreHidden: true };
  const floor = new Date(now.getTime() - L.maxAgeDays * DAY_MS);
  const leg = { scope, filters: {}, limit: L.legLimit };

  const recencyOnly = idsOf(await repo.queryRows(code.retrievalSql({ scope, filters: {}, fields: [], from: null, ageFloor: floor, to: null, limit: RECALL_K })));

  // Leg A as the feed runs it: 14 days, widened to 45 under 60 rows.
  let a = await repo.queryRows(code.recencyLegSql({ ...leg, from: new Date(now.getTime() - L.firstWindowDays * DAY_MS) }));
  if (a.length < L.widenBelowRows) a = await repo.queryRows(code.recencyLegSql({ ...leg, from: new Date(now.getTime() - L.widenWindowDays * DAY_MS) }));
  const tsQuery = personaQueryOf(persona, code);
  const b = tsQuery ? await repo.queryRows(code.lexicalLegSql({ ...leg, ageFloor: floor }, tsQuery)) : [];
  const vector = world.vectors.personas.get(persona.id);
  const c = vector ? await repo.queryRows(code.denseLegSql({ ...leg, ageFloor: floor }, code.vectorLiteral(vector), world.vectors.model)) : [];

  const posted = (id: string) => world.postedAt.get(id) ?? 0;
  const fused = code.fuseByReciprocalRank([idsOf(a), idsOf(b), idsOf(c)], { k: L.rrfK, cap: L.retrievalLimit, newer: (x, y) => posted(y) - posted(x) });
  return { recencyOnly, recency: idsOf(a), lexical: idsOf(b), dense: idsOf(c), fused: fused.map((f) => f.id) };
}

/** Share of `relevant` among the first `k` ids; null when nothing is relevant. */
export function recallAt(ids: readonly string[], relevant: ReadonlySet<string>, k: number = RECALL_K): number | null {
  if (!relevant.size) return null;
  let hit = 0;
  for (const id of ids.slice(0, k)) if (relevant.has(id)) hit += 1;
  return hit / relevant.size;
}

export interface PersonaRecall {
  persona: Persona;
  relevant: number;
  recency: number | null;
  hybrid: number | null;
}

export async function recallOfMarket(fx: MarketFixtures, world: RetrievalWorld): Promise<PersonaRecall[]> {
  const out: PersonaRecall[] = [];
  for (const persona of fx.personas) {
    const labels = fx.labels.labels[persona.id] ?? {};
    const relevant = new Set(Object.entries(labels).filter(([, grade]) => grade >= 2).map(([id]) => id));
    const legs = await retrieveFor(world, persona);
    out.push({ persona, relevant: relevant.size, recency: recallAt(legs.recencyOnly, relevant), hybrid: recallAt(legs.fused, relevant) });
  }
  return out;
}

const mean = (values: Array<number | null>): { value: number | null; n: number } => {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return { value: nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null, n: nums.length };
};

/** The measures of one market from its per-persona recall. Pure. */
export function measuresOf(market: SuiteMarket, rows: readonly PersonaRecall[], vectors: Pick<Vectors, 'kind' | 'model' | 'missing'>): SuiteMeasure[] {
  const gated = rows.filter((r) => r.persona.kind !== CAREER_CHANGER_SUBSET && r.recency !== null && r.hybrid !== null);
  const changers = rows.filter((r) => r.persona.kind === CAREER_CHANGER_SUBSET);
  const recency = mean(gated.map((r) => r.recency));
  const hybrid = mean(gated.map((r) => r.hybrid));
  const deltas = gated.map((r) => ({ id: r.persona.id, delta: r.hybrid! - r.recency! }));
  const worst = deltas.length ? deltas.reduce((w, d) => (d.delta < w.delta ? d : w)) : null;
  // A run on proxy vectors is printed and never held against the gate.
  const proxy = vectors.kind === 'proxy';
  const status = proxy ? ({ status: 'no_fixture' } as const) : {};
  // One note for the three gated rows of a market, so the report says it once.
  const note = proxy ? PROXY_NOTE : `recorded vectors of ${vectors.model}; the whole market with no filter; career changers are reported apart${worst ? `; worst persona ${worst.id}` : ''}`;
  const common = { market, labels: 'constructed' as const, note, ...status };
  const out: SuiteMeasure[] = [
    { metric: 'recall_at_200_recency', ...common, value: recency.value, n: recency.n },
    { metric: 'recall_at_200_hybrid', ...common, value: hybrid.value, n: hybrid.n, reference: recency.value },
    { metric: 'recall_at_200_worst_persona_delta', ...common, value: worst ? worst.delta : null, n: deltas.length },
  ];
  if (changers.length) {
    const apart = `${CAREER_CHANGER_NOTE}${proxy ? ON_PROXY : ''}`;
    const r = mean(changers.map((c) => c.recency));
    const h = mean(changers.map((c) => c.hybrid));
    out.push({ metric: 'recall_at_200_recency', market, subset: CAREER_CHANGER_SUBSET, labels: 'constructed', value: r.value, n: r.n, note: apart });
    // Its own metric id, so the row cannot be mistaken for the gated value. (Since the M4 gate the two retrieval
    // gates also leave this subset out themselves, `exceptSubsets` in gates.ts, as the ranking gates do.)
    out.push({ metric: 'recall_at_200_fused', market, subset: CAREER_CHANGER_SUBSET, labels: 'constructed', value: h.value, n: h.n, note: apart });
  }
  return out;
}

/** Recall per language subset, across the markets of the run, for the language comparison (printed, not gated). */
export function subsetMeasures(rows: readonly PersonaRecall[], proxy: boolean): SuiteMeasure[] {
  const compared = rows.filter((r) => r.persona.kind !== CAREER_CHANGER_SUBSET);
  const out: SuiteMeasure[] = [];
  for (const subset of SUBSETS) {
    const mine = compared.filter((r) => r.persona.subset === subset);
    if (!mine.length) continue;
    const note = `${SUBSET_NOTE}${proxy ? ON_PROXY : ''}`;
    const r = mean(mine.map((m) => m.recency));
    const h = mean(mine.map((m) => m.hybrid));
    out.push({ metric: 'recall_at_200_recency', layer: 'language', market: 'all', subset, labels: 'constructed', value: r.value, n: r.n, note });
    out.push({ metric: 'recall_at_200_hybrid', layer: 'language', market: 'all', subset, labels: 'constructed', value: h.value, n: h.n, note });
  }
  return out;
}

// ── Live mode: record vectors, time the real statements ───────────────────

export type ReadOnlyQuery = <T>(sql: Sql) => Promise<T[]>;

export interface RetrievalSuiteDeps {
  /** Where `vectors.<market>.json` is read from and written to (default `<fixturesDir>/retrieval`). */
  vectorsDir?: string;
  /** The embeddings client (platform/embeddings `embedTexts`), called inside the market's brand settings. Live only. */
  embed?: (brand: 'roboapply' | 'goapply', texts: readonly string[], options: { purpose: 'job' | 'user'; carriesUserData: boolean }) => Promise<{ vectors: number[][]; model: string } | { unavailable: string }>;
  /** Run `fn` with a query function that can only read (live/snapshot.ts `defaultWithReadOnly`). Live only. */
  withReadOnly?: <T>(fn: (query: ReadOnlyQuery) => Promise<T>) => Promise<T>;
  /** The model tag vector comparisons of a market filter on (retrieval `currentModelTag`). Live only. */
  queryModelTag?: (market: SuiteMarket) => Promise<string | null>;
  /** Milliseconds, monotonic. */
  clock?: () => number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

const brandOf = (market: SuiteMarket): 'roboapply' | 'goapply' => (market === 'cn' ? 'goapply' : 'roboapply');

/**
 * Embed the synthetic texts of one market that the file does not hold yet
 * (same text, same model) and write `vectors.<market>.json`. When the model
 * has changed since the file was recorded, nothing of it is reused: vectors
 * of two models are never compared, so the whole file is recorded again.
 * Answers the file as it now is, or null with a reason when nothing could be
 * recorded (then the file on disk is left as it was).
 */
export async function recordVectors(input: { market: SuiteMarket; texts: Texts; dir: string; now: Date; embed: NonNullable<RetrievalSuiteDeps['embed']> }): Promise<{ file: VectorsFile | null; embedded: number; reason?: string }> {
  const { market, texts, dir } = input;
  const kinds: Array<['postings' | 'personas', Map<string, string>, 'job' | 'user']> = [
    ['postings', texts.postings, 'job'],
    ['personas', texts.personas, 'user'],
  ];
  let reuse = readVectorsFile(dir, market);
  const fresh: Pick<VectorsFile, 'postings' | 'personas'> = { postings: {}, personas: {} };
  let model: string | null = null;
  let embedded = 0;
  // At most two passes: the second only when the first found the file was recorded with another model.
  for (let pass = 0; pass < 2; pass += 1) {
    let modelChanged = false;
    for (const [kind, wanted, purpose] of kinds) {
      const need = [...wanted.keys()].filter((id) => !fresh[kind][id] && reuse?.[kind][id]?.hash !== textHash(wanted.get(id)!));
      if (!need.length) continue;
      // Synthetic postings and synthetic resumes: no user data is sent.
      const res = await input.embed(brandOf(market), need.map((id) => wanted.get(id)!), { purpose, carriesUserData: false });
      if ('unavailable' in res) return { file: null, embedded, reason: `the embeddings client is unavailable (${res.unavailable})` };
      if (model !== null && res.model !== model) return { file: null, embedded, reason: `the embeddings client answered with two models in one run (${model}, ${res.model})` };
      model = res.model;
      need.forEach((id, i) => {
        fresh[kind][id] = { hash: textHash(wanted.get(id)!), v: encodeVector(res.vectors[i]!) };
      });
      embedded += need.length;
      if (reuse && reuse.model !== model) {
        reuse = null;
        modelChanged = true;
        break;
      }
    }
    if (!modelChanged) break;
  }
  // Nothing needed embedding: the file on disk already covers every text.
  if (model === null) return reuse ? { file: reuse, embedded: 0 } : { file: null, embedded: 0, reason: 'there is no text to embed' };
  const out: VectorsFile = {
    _synthetic: true,
    _generatedBy: 'EVAL_LIVE=1 npm run eval:match -- --live (suites/retrieval.suite.ts)',
    market,
    model,
    dimensions: VECTOR_DIMENSIONS,
    encoding: 'f32le-base64',
    recordedAt: input.now.toISOString(),
    postings: {},
    personas: {},
  };
  for (const [kind, wanted] of kinds) {
    for (const id of wanted.keys()) {
      const entry = fresh[kind][id] ?? reuse?.[kind][id];
      if (entry) out[kind][id] = entry;
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, VECTORS_FILE(market)), `${JSON.stringify(out)}\n`);
  return { file: out, embedded };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/**
 * Time the feed's first-window statements for every persona on the real
 * index, read-only: the three legs together when hybrid retrieval is on (the
 * dense leg only when the recorded vectors are of the market's query model),
 * the single recency statement when FEED_HYBRID=off. The filters are the
 * persona's role and place, as the live snapshot's recency variant asks.
 */
export async function timeFirstWindow(input: { market: SuiteMarket; personas: Persona[]; code: Code; vectors: Vectors; now: Date; deps: Required<Pick<RetrievalSuiteDeps, 'withReadOnly' | 'clock'>> & Pick<RetrievalSuiteDeps, 'queryModelTag' | 'env'> }): Promise<{ p95: number | null; n: number; hybrid: boolean; dense: boolean }> {
  const { code, now, deps } = input;
  const L = code.limits;
  const hybrid = (deps.env?.FEED_HYBRID ?? '').trim().toLowerCase() !== 'off';
  const tag = hybrid && input.vectors.kind === 'recorded' && deps.queryModelTag ? await deps.queryModelTag(input.market).catch(() => null) : null;
  const dense = !!tag && tag === input.vectors.model;
  const floor = new Date(now.getTime() - L.maxAgeDays * DAY_MS);
  const from = new Date(now.getTime() - L.firstWindowDays * DAY_MS);
  const times: number[] = [];
  await deps.withReadOnly(async (query) => {
    for (const persona of input.personas) {
      const scope = { market: input.market, userId: null, now, publicOnly: true, ignoreHidden: true };
      const filters = { taxonomyIds: [persona.targetRoleId], locations: [persona.location] };
      const started = deps.clock();
      if (!hybrid) {
        await query(code.retrievalSql({ scope, filters, fields: ['taxonomyIds', 'locations'], from, to: null, limit: L.retrievalLimit }));
      } else {
        const leg = { scope, filters, fields: ['taxonomyIds', 'locations'], limit: L.legLimit };
        const tsQuery = personaQueryOf(persona, code);
        const vector = dense ? input.vectors.personas.get(persona.id) : undefined;
        await Promise.all([
          query(code.recencyLegSql({ ...leg, from })),
          tsQuery ? query(code.lexicalLegSql({ ...leg, ageFloor: floor }, tsQuery)) : Promise.resolve([]),
          vector ? query(code.denseLegSql({ ...leg, ageFloor: floor }, code.vectorLiteral(vector), tag!)) : Promise.resolve([]),
        ]);
      }
      times.push(deps.clock() - started);
    }
  });
  return { p95: percentile(times, 0.95), n: times.length, hybrid, dense };
}

async function liveDeps(deps: RetrievalSuiteDeps): Promise<Required<Pick<RetrievalSuiteDeps, 'embed' | 'withReadOnly' | 'clock'>> & Pick<RetrievalSuiteDeps, 'queryModelTag' | 'env'>> {
  const embed = deps.embed ?? (await loadSeam<NonNullable<RetrievalSuiteDeps['embed']>>('server/src/platform/embeddings/index.ts#embedTexts'));
  const withReadOnly = deps.withReadOnly ?? (await loadSeam<NonNullable<RetrievalSuiteDeps['withReadOnly']>>(`${F}/match/eval/live/snapshot.ts#defaultWithReadOnly`));
  const queryModelTag = deps.queryModelTag ?? (await loadSeam<NonNullable<RetrievalSuiteDeps['queryModelTag']>>(`${F}/retrieval/index.ts#currentModelTag`));
  return { embed, withReadOnly, queryModelTag, clock: deps.clock ?? (() => performance.now()), env: deps.env ?? process.env };
}

// ── The suite ─────────────────────────────────────────────────────────────

export async function run(ctx: SuiteContext, deps: RetrievalSuiteDeps = {}): Promise<SuiteMeasure[]> {
  const out: SuiteMeasure[] = [];
  const all: PersonaRecall[] = [];
  const dir = deps.vectorsDir ?? path.join(ctx.fixturesDir, 'retrieval');
  const log = deps.log ?? (() => undefined);
  let proxy = false;
  for (const market of ctx.markets) {
    const fx = loadMarketFixtures(market, ctx.fixturesDir);
    if (!fx) {
      for (const metric of METRICS) out.push(unmeasured(metric, 'no_fixture', `no personas, postings or labels for ${market} in fixtures/`, { market }));
      continue;
    }
    try {
      const code = await loadCode();
      let file = readVectorsFile(dir, market);
      let live: Awaited<ReturnType<typeof liveDeps>> | null = null;
      if (ctx.live) {
        live = await liveDeps(deps);
        const recorded = await recordVectors({ market, texts: textsOf(fx, code), dir, now: ctx.now, embed: live.embed });
        if (recorded.file) file = recorded.file;
        log(recorded.file ? `retrieval: ${recorded.embedded} synthetic text(s) of ${market} embedded with ${recorded.file.model}; vectors written to ${path.join(dir, VECTORS_FILE(market))}` : `retrieval: no vectors recorded for ${market}: ${recorded.reason}`);
      }
      const world = buildWorld(fx, code, file);
      const rows = await recallOfMarket(fx, world);
      all.push(...rows);
      proxy ||= world.vectors.kind === 'proxy';
      out.push(...measuresOf(market, rows, world.vectors));
      if (live) {
        const timed = await timeFirstWindow({ market, personas: fx.personas, code, vectors: world.vectors, now: ctx.now, deps: live });
        const how = timed.hybrid ? `the three legs together${timed.dense ? '' : ' (no dense leg: no recorded vector of the market query model)'}` : 'the single recency statement (FEED_HYBRID=off)';
        out.push({ metric: 'feed_p95_ms', layer: 'latency', market, scope: 'live', value: timed.p95, n: timed.n, labels: 'none', note: `first-window statements on the real index, read-only, one run per synthetic persona: ${how}` });
      } else {
        // The in-memory rows say nothing about the time a statement takes on the real index.
        out.push(unmeasured('feed_p95_ms', 'skipped_offline', LATENCY_OFFLINE_NOTE, { layer: 'latency', market }));
      }
    } catch (err) {
      for (const metric of METRICS) out.push(notBuiltOrThrow(metric, err, { market }));
    }
  }
  out.push(...subsetMeasures(all, proxy));
  return out;
}
