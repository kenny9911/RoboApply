// server/src/features/match/eval/suites/skills.suite.ts
//
// Skills layer (strategy 2.6; SM-6): precision of "Not shown" at least 95% on
// 100 labelled resume-job pairs. We must not tell people they lack what they
// have.
//
// The keyword check (`buildKeywordRows`) runs on every pair of
// fixtures/skills/pairs.json, and each item it lists is compared with the
// state a person gave that skill by hand (`shown`, `related`, `not_shown`).
// The vocabulary is the committed seed (features/skills/seed/skills.seed.json)
// plus fixtures/skills/vocabulary.extension.json, pinned through the skills
// test seam for the length of the run and released afterwards.
//
// A posting is built the way enrichment v3 writes it (jobs/enrich/reconcile.ts
// `reconcileSkills`): ONE `skillsDetail` entry per skill, with the id the
// vocabulary's exact-alias step gives its strings, shown under the spelling
// that is the skill's own label when the posting uses it, else the first;
// `skills` keeps every spelling, lower case; the ids of the hard ones are in
// `skillIds`; and each skill is one keyword with its id (so the two rows must
// not repeat each other). Soft skills of the posting are there too and must
// not be listed.
//
// Values (shares are 0 to 1):
//   precision_not_shown        GATED: of the items the check calls not shown,
//                              the share a person also calls not shown
//   precision_shown, precision_related, recall_shown, recall_related,
//   recall_not_shown           information
//   duplicate_items            items that repeat a skill inside one check (must be 0)
//   unlisted_items             labelled skills the check lists nothing for
//                              (neither claimed nor denied)
//   soft_items_listed          soft skills that became an item (must be 0)
//   precision_not_shown_without_ids
//                              the same pairs with the ids taken off the
//                              posting: the path a posting takes until it is
//                              re-enriched. Information, not gated.
//
// Labels: `authored`. The states were written by hand by the engineer of the
// check, not graded by a recruiter, and the report says so.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { matchJob, matchUser } from '../../testkit.js';
import type { GateLayer } from '../gates.js';
import { SEAMS, loadSeam } from '../seams.js';
import { notBuiltOrThrow, unmeasured, type SuiteContext, type SuiteMarket, type SuiteMeasure } from '../suite.js';

export const name = 'skills';
export const layer: GateLayer = 'skills';

export const SKILLS_FIXTURE_DIR = 'skills';
export const PAIRS_FILE = 'pairs.json';
export const EXTENSION_FILE = 'vocabulary.extension.json';
/** The committed seed of the vocabulary, read by path (the product loads the same file). */
export const SEED_FILE = 'server/src/features/skills/seed/skills.seed.json';

export const SKILL_STATES = ['shown', 'related', 'not_shown'] as const;
export type SkillState = (typeof SKILL_STATES)[number];
/** The language classes of the gate's minimums: both sides English, both Simplified, both Traditional, or two different languages. */
export const PAIR_SUBSETS = ['en', 'zh-CN', 'zh-TW', 'cross'] as const;
export type PairSubset = (typeof PAIR_SUBSETS)[number];

export interface LabelledSkill {
  name: string;
  required?: boolean;
  expected: SkillState;
  reason: string;
}

export interface SkillsPair {
  id: string;
  market: SuiteMarket;
  subset: PairSubset;
  resumeLang: string;
  postingLang: string;
  basedOn?: { groupId: string; roleId: string };
  resume: { title: string; skills: string[]; markdown: string };
  posting: { title: string; skills: LabelledSkill[]; keywords?: LabelledSkill[]; softSkills?: string[] };
}

export interface PairsFile {
  _synthetic: true;
  _labels: string;
  pairs: SkillsPair[];
}

const isState = (v: unknown): v is SkillState => typeof v === 'string' && (SKILL_STATES as readonly string[]).includes(v);

/** The pairs of a parsed fixture file; throws with the reason when the shape is wrong. */
export function readPairs(raw: unknown): SkillsPair[] {
  const file = raw as Partial<PairsFile> | null;
  if (!file || file._synthetic !== true || !Array.isArray(file.pairs)) throw new Error('skills pairs: expected { "_synthetic": true, "pairs": [...] }');
  for (const p of file.pairs) {
    const where = `skills pair ${String((p as SkillsPair | null)?.id)}`;
    if (!p || typeof p.id !== 'string' || (p.market !== 'intl' && p.market !== 'cn')) throw new Error(`${where}: id and market are required`);
    if (!(PAIR_SUBSETS as readonly string[]).includes(p.subset)) throw new Error(`${where}: subset must be one of ${PAIR_SUBSETS.join(', ')}`);
    if (!p.resume || typeof p.resume.markdown !== 'string' || !Array.isArray(p.resume.skills)) throw new Error(`${where}: a resume with markdown and skills is required`);
    if (!p.posting || !Array.isArray(p.posting.skills) || !p.posting.skills.length) throw new Error(`${where}: a posting with skills is required`);
    for (const s of [...p.posting.skills, ...(p.posting.keywords ?? [])]) {
      if (!s || typeof s.name !== 'string' || !s.name.trim()) throw new Error(`${where}: a skill has no name`);
      if (!isState(s.expected)) throw new Error(`${where}: "${s.name}" has the state ${String(s.expected)}; expected one of ${SKILL_STATES.join(', ')}`);
      if (typeof s.reason !== 'string' || !s.reason.trim()) throw new Error(`${where}: "${s.name}" has no reason`);
    }
  }
  return file.pairs;
}

// ── What the suite reads of the code under test (structural views) ────────

interface VocabularyLike {
  idOf(term: string): string | null;
  kindOf(id: string): string | null;
  reviewed(id: string): boolean;
  label(id: string, locale: string): string;
}
interface ItemLike {
  term: string;
  state?: string;
  found?: boolean;
  skillId?: string | null;
}
interface RowLike {
  key: string;
  items: ItemLike[];
}
type BuildKeywordRows = (input: Record<string, unknown>) => RowLike[];

export interface SkillsSeams {
  buildKeywordRows: BuildKeywordRows;
  normalizeText: (text: string) => string;
  buildVocabulary: (records: readonly unknown[], options?: { droppedKeys?: Iterable<string> }) => VocabularyLike;
  setVocabularyForTests: (vocabulary: unknown) => void;
}

export const SKILLS_SEAMS = {
  buildKeywordRows: SEAMS.buildKeywordRows,
  normalizeText: 'server/src/features/match/keywordRows.ts#normalizeText',
  buildVocabulary: 'server/src/features/skills/index.ts#buildVocabulary',
  setVocabularyForTests: 'server/src/features/skills/index.ts#setVocabularyForTests',
} as const;

export async function loadSkillsSeams(): Promise<SkillsSeams> {
  return {
    buildKeywordRows: await loadSeam<BuildKeywordRows>(SKILLS_SEAMS.buildKeywordRows),
    normalizeText: await loadSeam<SkillsSeams['normalizeText']>(SKILLS_SEAMS.normalizeText),
    buildVocabulary: await loadSeam<SkillsSeams['buildVocabulary']>(SKILLS_SEAMS.buildVocabulary),
    setVocabularyForTests: await loadSeam<SkillsSeams['setVocabularyForTests']>(SKILLS_SEAMS.setVocabularyForTests),
  };
}

// ── Measuring ─────────────────────────────────────────────────────────────

export type Predicted = SkillState | 'unlisted';

export interface Comparison {
  pairId: string;
  subset: PairSubset;
  market: SuiteMarket;
  name: string;
  expected: SkillState;
  predicted: Predicted;
  reason: string;
}

export interface SkillsResult {
  comparisons: Comparison[];
  /** Items that repeat a skill (one id, or one spelling) inside one check. */
  duplicates: Array<{ pairId: string; term: string }>;
  /** Soft skills of the posting that became an item. */
  softListed: Array<{ pairId: string; term: string }>;
  /** Pairs whose labels give one skill two different states (a fixture error). */
  conflicts: Array<{ pairId: string; name: string }>;
}

const termKeyOf = (t: string): string => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, '');

/** How enrichment stores a skill string: trimmed, single spaces, lower case. */
const stored = (skill: string): string => skill.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export interface PostingSkillRow {
  skills: string[];
  skillsDetail: Array<{ skill: string; kind: string; required: boolean; skillId?: string | null; via?: string }>;
  skillIds: string[];
  /** One keyword per hard skill, as enrichment v3 keeps them (`high` when required), then the posting's other terms. */
  keywords: Array<{ keyword: string; importance: string; skillId?: string | null }>;
}

/**
 * The skill fields of a posting row as enrichment writes them.
 *
 * `withIds` (version 3): the strings of the posting are grouped by the
 * canonical id of the exact-alias step. Each group is ONE `skillsDetail` entry
 * (required when one of its spellings is; the vocabulary's kind when the skill
 * is reviewed), shown under the spelling that is one of the skill's labels
 * when the posting uses it, else the first. `skills` keeps every spelling. A
 * string the vocabulary does not know is a group of its own, without an id.
 *
 * Without ids (a posting version 3 has not written yet): one entry per string
 * and no id anywhere.
 */
export function postingSkillRow(posting: SkillsPair['posting'], vocabulary: VocabularyLike, options: { withIds: boolean }): PostingSkillRow {
  const soft = posting.softSkills ?? [];
  const sources = [
    ...posting.skills.map((s) => ({ skill: stored(s.name), kind: 'hard', required: s.required === true })),
    ...soft.map((s) => ({ skill: stored(s), kind: 'soft', required: false })),
  ];
  const extra = posting.keywords ?? [];
  if (!options.withIds) {
    return {
      skills: [...new Set(sources.map((s) => s.skill))],
      skillsDetail: sources.map((s) => ({ skill: s.skill, kind: s.kind, required: s.required })),
      skillIds: [],
      keywords: [
        ...posting.skills.map((s) => ({ keyword: s.name, importance: s.required ? 'high' : 'medium' })),
        ...soft.map((s) => ({ keyword: s, importance: 'medium' })),
        ...extra.map((s) => ({ keyword: s.name, importance: 'medium' })),
      ],
    };
  }
  interface Group {
    skillId: string | null;
    strings: string[];
    kind: string;
    required: boolean;
  }
  const groups = new Map<string, Group>();
  const skills: string[] = [];
  for (const source of sources) {
    if (!skills.includes(source.skill)) skills.push(source.skill);
    const skillId = vocabulary.idOf(source.skill);
    const key = skillId ? `id:${skillId}` : `term:${source.skill}`;
    let group = groups.get(key);
    if (!group) {
      group = { skillId, strings: [], kind: source.kind, required: false };
      groups.set(key, group);
    }
    if (!group.strings.includes(source.skill)) group.strings.push(source.skill);
    group.required ||= source.required;
  }
  const skillsDetail = [...groups.values()].map((group) => {
    const reviewed = !!group.skillId && vocabulary.reviewed(group.skillId);
    const labels = group.skillId ? ['en', 'zh', 'zh-TW'].map((locale) => stored(vocabulary.label(group.skillId!, locale))).filter(Boolean) : [];
    return {
      skill: group.strings.find((x) => labels.includes(x)) ?? group.strings[0]!,
      kind: reviewed ? (vocabulary.kindOf(group.skillId!) ?? group.kind) : group.kind,
      required: group.required,
      skillId: group.skillId,
      via: group.skillId ? 'alias' : 'none',
    };
  });
  const scored = skillsDetail.filter((d) => d.skillId && d.kind !== 'soft');
  return {
    skills,
    skillsDetail,
    skillIds: [...new Set([...scored.filter((d) => d.required), ...scored.filter((d) => !d.required)].map((d) => d.skillId!))],
    keywords: [
      ...scored.map((d) => ({ keyword: d.skill, importance: d.required ? 'high' : 'medium', skillId: d.skillId })),
      // Terms a row written before version 3 may still hold next to them: a soft skill and the pair's other labelled terms.
      ...soft.map((s) => ({ keyword: s, importance: 'medium' })),
      ...extra.map((s) => ({ keyword: s.name, importance: 'medium', skillId: vocabulary.idOf(s.name) })),
    ],
  };
}

/**
 * Run the keyword check on every pair. `withIds: false` takes the ids off the
 * posting, which is the state of a posting enrichment v3 has not written yet.
 * The vocabulary must be pinned by the caller.
 */
export function comparePairs(pairs: readonly SkillsPair[], seams: Pick<SkillsSeams, 'buildKeywordRows' | 'normalizeText'>, vocabulary: VocabularyLike, options: { withIds: boolean }): SkillsResult {
  const out: SkillsResult = { comparisons: [], duplicates: [], softListed: [], conflicts: [] };
  for (const pair of pairs) {
    const idOf = (term: string): string | null => {
      const id = vocabulary.idOf(term);
      return id && vocabulary.reviewed(id) ? id : null;
    };
    const soft = pair.posting.softSkills ?? [];
    const row = postingSkillRow(pair.posting, vocabulary, options);
    const job = {
      ...matchJob({
        id: pair.id,
        market: pair.market,
        title: pair.posting.title,
        lang: pair.postingLang,
        taxonomyIds: [],
        primaryTaxonomyId: null,
        skills: row.skills,
        skillsDetail: row.skillsDetail,
        ...(row.skillIds.length ? { skillIds: row.skillIds } : {}),
      }),
      minYears: null,
    };
    const user = matchUser({ market: pair.market, skills: pair.resume.skills, resumeTextNorm: seams.normalizeText(pair.resume.markdown), recentTitle: pair.resume.title, evidenceRoleIds: [] });
    // Enrichment v3 keeps a posting's skills as its keywords too; the check must not list them twice.
    const keywords = row.keywords;
    const rows = seams.buildKeywordRows({ job, user, resumeText: pair.resume.markdown, keywords, locale: 'en' });
    const items = rows.filter((r) => r.key === 'skills' || r.key === 'keywords').flatMap((r) => r.items ?? []);

    const seenIds = new Set<string>();
    const seenTerms = new Set<string>();
    for (const item of items) {
      const term = termKeyOf(item.term);
      if ((item.skillId && seenIds.has(item.skillId)) || seenTerms.has(term)) out.duplicates.push({ pairId: pair.id, term: item.term });
      if (item.skillId) seenIds.add(item.skillId);
      seenTerms.add(term);
    }
    const softKeys = new Set(soft.map(termKeyOf));
    const softIds = new Set(soft.map((s) => vocabulary.idOf(s)).filter((id): id is string => !!id));
    for (const item of items) if (softKeys.has(termKeyOf(item.term)) || (item.skillId && softIds.has(item.skillId))) out.softListed.push({ pairId: pair.id, term: item.term });

    // One comparison per skill of the pair: two spellings of one skill are one skill.
    const done = new Map<string, SkillState>();
    for (const label of [...pair.posting.skills, ...(pair.posting.keywords ?? [])]) {
      const id = idOf(label.name);
      const key = id ? `id:${id}` : `term:${termKeyOf(label.name)}`;
      const earlier = done.get(key);
      if (earlier !== undefined) {
        if (earlier !== label.expected) out.conflicts.push({ pairId: pair.id, name: label.name });
        continue;
      }
      done.set(key, label.expected);
      const item = items.find((i) => (id ? i.skillId === id : false)) ?? items.find((i) => termKeyOf(i.term) === termKeyOf(label.name));
      const predicted: Predicted = item && (SKILL_STATES as readonly string[]).includes(item.state ?? '') ? (item.state as SkillState) : 'unlisted';
      out.comparisons.push({ pairId: pair.id, subset: pair.subset, market: pair.market, name: label.name, expected: label.expected, predicted, reason: label.reason });
    }
  }
  return out;
}

export interface StateScore {
  precision: number | null;
  recall: number | null;
  predicted: number;
  expected: number;
  correct: number;
}

export function scoreState(comparisons: readonly Comparison[], state: SkillState): StateScore {
  const predicted = comparisons.filter((c) => c.predicted === state);
  const expected = comparisons.filter((c) => c.expected === state);
  const correct = predicted.filter((c) => c.expected === state).length;
  return { precision: predicted.length ? correct / predicted.length : null, recall: expected.length ? correct / expected.length : null, predicted: predicted.length, expected: expected.length, correct };
}

const pct = (n: number | null): string => (n === null ? 'n/a' : `${(Math.round(n * 1000) / 10).toFixed(1)}%`);

/** The misses of one predicted state, as words for a note. */
function missesOf(comparisons: readonly Comparison[], state: SkillState, max = 12): string {
  const wrong = comparisons.filter((c) => c.predicted === state && c.expected !== state);
  if (!wrong.length) return 'no miss';
  const shown = wrong.slice(0, max).map((c) => `${c.pairId} "${c.name}" (a person says ${c.expected.replace('_', ' ')}: ${c.reason})`);
  return `${wrong.length} miss${wrong.length === 1 ? '' : 'es'}: ${shown.join('; ')}${wrong.length > max ? `; and ${wrong.length - max} more` : ''}`;
}

function bySubset(comparisons: readonly Comparison[]): string {
  return PAIR_SUBSETS.map((subset) => {
    const s = scoreState(comparisons.filter((c) => c.subset === subset), 'not_shown');
    return `${subset} ${pct(s.precision)} (${s.correct} of ${s.predicted})`;
  }).join(', ');
}

export function loadSkillsFixtures(ctx: Pick<SuiteContext, 'fixturesDir' | 'repoRoot'>): { pairs: SkillsPair[]; records: unknown[]; droppedKeys: string[] } | null {
  const pairsFile = path.join(ctx.fixturesDir, SKILLS_FIXTURE_DIR, PAIRS_FILE);
  const extensionFile = path.join(ctx.fixturesDir, SKILLS_FIXTURE_DIR, EXTENSION_FILE);
  const seedFile = path.join(ctx.repoRoot, SEED_FILE);
  if (!existsSync(pairsFile) || !existsSync(extensionFile) || !existsSync(seedFile)) return null;
  const seed = JSON.parse(readFileSync(seedFile, 'utf8')) as { skills?: unknown[]; dropped?: unknown[] };
  const extension = JSON.parse(readFileSync(extensionFile, 'utf8')) as { _synthetic?: unknown; skills?: unknown[] };
  if (extension._synthetic !== true || !Array.isArray(extension.skills)) throw new Error('skills vocabulary extension: expected { "_synthetic": true, "skills": [...] }');
  if (!Array.isArray(seed.skills)) throw new Error(`${SEED_FILE}: expected { "skills": [...] }`);
  return {
    pairs: readPairs(JSON.parse(readFileSync(pairsFile, 'utf8'))),
    records: [...seed.skills, ...extension.skills],
    droppedKeys: (seed.dropped ?? []).filter((k): k is string => typeof k === 'string'),
  };
}

export async function run(ctx: SuiteContext): Promise<SuiteMeasure[]> {
  const market: SuiteMarket | 'all' = ctx.markets.length === 1 ? ctx.markets[0]! : 'all';
  let fixtures: ReturnType<typeof loadSkillsFixtures>;
  try {
    fixtures = loadSkillsFixtures(ctx);
  } catch (err) {
    return [unmeasured('precision_not_shown', 'no_fixture', err instanceof Error ? err.message : String(err), { market })];
  }
  if (!fixtures) return [unmeasured('precision_not_shown', 'no_fixture', `fixtures/${SKILLS_FIXTURE_DIR}/${PAIRS_FILE} or its vocabulary is not on disk`, { market })];
  const pairs = fixtures.pairs.filter((p) => ctx.markets.includes(p.market));
  if (!pairs.length) return [unmeasured('precision_not_shown', 'no_fixture', `no skills pair for ${ctx.markets.join(', ')}`, { market })];

  let seams: SkillsSeams;
  try {
    seams = await loadSkillsSeams();
  } catch (err) {
    return [notBuiltOrThrow('precision_not_shown', err, { market })];
  }
  const vocabulary = seams.buildVocabulary(fixtures.records, { droppedKeys: fixtures.droppedKeys });
  let result: SkillsResult;
  let withoutIds: SkillsResult;
  // The check reads the process-wide vocabulary: pin the fixture for the run and hand the loader back afterwards.
  seams.setVocabularyForTests(vocabulary);
  try {
    result = comparePairs(pairs, seams, vocabulary, { withIds: true });
    withoutIds = comparePairs(pairs, seams, vocabulary, { withIds: false });
  } finally {
    seams.setVocabularyForTests(null);
  }
  if (result.conflicts.length) throw new Error(`skills pairs: one skill carries two states in ${result.conflicts.map((c) => `${c.pairId} "${c.name}"`).join(', ')}`);

  const c = result.comparisons;
  const notShown = scoreState(c, 'not_shown');
  const shown = scoreState(c, 'shown');
  const related = scoreState(c, 'related');
  const unlisted = c.filter((x) => x.predicted === 'unlisted');
  const legacy = scoreState(withoutIds.comparisons, 'not_shown');
  const base = { market, labels: 'authored' as const };
  return [
    {
      ...base,
      metric: 'precision_not_shown',
      value: notShown.precision,
      n: notShown.predicted,
      note: `${pairs.length} pairs, ${c.length} labelled skills; ${notShown.correct} of ${notShown.predicted} "not shown" answers are right; by language: ${bySubset(c)}; ${missesOf(c, 'not_shown')}`,
    },
    { ...base, metric: 'recall_not_shown', value: notShown.recall, n: notShown.expected },
    { ...base, metric: 'precision_shown', value: shown.precision, n: shown.predicted, note: missesOf(c, 'shown', 6) },
    { ...base, metric: 'recall_shown', value: shown.recall, n: shown.expected },
    { ...base, metric: 'precision_related', value: related.precision, n: related.predicted, note: missesOf(c, 'related', 6) },
    { ...base, metric: 'recall_related', value: related.recall, n: related.expected },
    {
      ...base,
      metric: 'duplicate_items',
      value: result.duplicates.length,
      n: pairs.length,
      note: result.duplicates.length ? `must be 0: ${result.duplicates.slice(0, 8).map((d) => `${d.pairId} "${d.term}"`).join('; ')}` : 'no skill is listed twice in any check',
    },
    {
      ...base,
      metric: 'unlisted_items',
      value: unlisted.length,
      n: c.length,
      note: unlisted.length ? `neither claimed nor denied: ${unlisted.slice(0, 8).map((u) => `${u.pairId} "${u.name}" (a person says ${u.expected.replace('_', ' ')})`).join('; ')}` : 'every labelled skill is listed',
    },
    { ...base, metric: 'soft_items_listed', value: result.softListed.length, n: pairs.length, note: result.softListed.length ? `must be 0: ${result.softListed.map((d) => `${d.pairId} "${d.term}"`).join('; ')}` : 'no soft skill is listed' },
    {
      ...base,
      metric: 'precision_not_shown_without_ids',
      value: legacy.precision,
      n: legacy.predicted,
      note: `the same pairs with the skill ids taken off the posting (a posting enrichment v3 has not written yet); ${missesOf(withoutIds.comparisons, 'not_shown', 6)}`,
    },
  ];
}
