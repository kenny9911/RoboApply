// @vitest-environment node
//
// The skills gate (MARKET_STRATEGY 2.6; SM-6): the shape of its fixtures, the
// arithmetic of the suite, and the gate itself on the committed pairs, so
// "precision of Not shown at least 95%, no skill listed twice" holds in
// `npm test` and not only in `npm run eval:match`.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { buildVocabulary, current, resetVocabularyForTests } from '../../../skills/index.js';
import { compareWithGate, findGate } from '../gates.js';
import { EVAL_DIR, REPO_ROOT } from '../seams.js';
import type { SuiteContext, SuiteMeasure } from '../suite.js';
import {
  EXTENSION_FILE,
  PAIRS_FILE,
  PAIR_SUBSETS,
  SEED_FILE,
  SKILLS_FIXTURE_DIR,
  SKILL_STATES,
  comparePairs,
  layer,
  loadSkillsFixtures,
  name,
  postingSkillRow,
  readPairs,
  run,
  scoreState,
  type Comparison,
  type SkillsPair,
} from './skills.suite.js';

const FIXTURES_DIR = path.join(EVAL_DIR, 'fixtures');
const DIR = path.join(FIXTURES_DIR, SKILLS_FIXTURE_DIR);
const ctx = (over: Partial<SuiteContext> = {}): SuiteContext => ({ markets: ['intl', 'cn'], live: false, repoRoot: REPO_ROOT, evalDir: EVAL_DIR, fixturesDir: FIXTURES_DIR, now: new Date('2026-10-11T00:00:00Z'), ...over });

const fixtures = loadSkillsFixtures(ctx())!;
const pairs = fixtures.pairs;
const vocabulary = buildVocabulary(fixtures.records as never, { droppedKeys: fixtures.droppedKeys });
const labelsOf = (p: SkillsPair) => [...p.posting.skills, ...(p.posting.keywords ?? [])];
const byMetric = (measures: SuiteMeasure[]) => Object.fromEntries(measures.map((m) => [m.metric, m])) as Record<string, SuiteMeasure>;

describe('fixtures/skills: the shape of the labelled pairs', () => {
  it('both files say they are synthetic, first of all; the labels are authored, never human', () => {
    for (const file of [PAIRS_FILE, EXTENSION_FILE]) expect(readFileSync(path.join(DIR, file), 'utf8').replace(/\s+/g, '').startsWith('{"_synthetic":true'), file).toBe(true);
    const raw = JSON.parse(readFileSync(path.join(DIR, PAIRS_FILE), 'utf8')) as { _labels: string; _note: string };
    expect(raw._labels).toBe('authored');
    expect(raw._note).toContain('not graded by a recruiter');
    for (const p of pairs) expect(p.resume.markdown, p.id).toMatch(/synthetic|虚构|虛構/);
  });

  it('holds 100 pairs with their own ids, at least 25 in Simplified Chinese, 10 in Traditional Chinese and 10 cross-language', () => {
    expect(pairs).toHaveLength(100);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(100);
    for (const p of pairs) expect(p.id).toMatch(/^sk-(en|cn|tw|x)-\d{2}$/);
    const count = (subset: string) => pairs.filter((p) => p.subset === subset).length;
    expect(count('zh-CN')).toBeGreaterThanOrEqual(25);
    expect(count('zh-TW')).toBeGreaterThanOrEqual(10);
    expect(count('cross')).toBeGreaterThanOrEqual(10);
    expect(PAIR_SUBSETS.reduce((n, s) => n + count(s), 0)).toBe(100);
    // A pair's class is what its two languages say.
    for (const p of pairs) {
      if (p.subset === 'cross') expect(p.resumeLang, p.id).not.toBe(p.postingLang);
      else expect([p.resumeLang, p.postingLang], p.id).toEqual([p.subset, p.subset]);
    }
    // Simplified pairs are GoApply's, Traditional and English ones RoboApply's; cross-language pairs exist on both.
    expect(pairs.filter((p) => p.subset === 'zh-CN').every((p) => p.market === 'cn')).toBe(true);
    expect(pairs.filter((p) => p.subset === 'zh-TW' || p.subset === 'en').every((p) => p.market === 'intl')).toBe(true);
    expect(new Set(pairs.filter((p) => p.subset === 'cross').map((p) => p.market))).toEqual(new Set(['intl', 'cn']));
  });

  it('every labelled skill has one of the three states and a one-line reason; all three states are well represented', () => {
    const labels = pairs.flatMap(labelsOf);
    expect(labels.length).toBeGreaterThanOrEqual(400);
    for (const p of pairs) {
      for (const s of labelsOf(p)) {
        expect(SKILL_STATES as readonly string[], `${p.id} ${s.name}`).toContain(s.expected);
        expect(s.reason.trim().length, `${p.id} ${s.name}`).toBeGreaterThan(5);
        expect(s.reason, `${p.id} ${s.name}`).not.toContain('\n');
      }
    }
    for (const state of SKILL_STATES) expect(labels.filter((l) => l.expected === state).length, state).toBeGreaterThanOrEqual(50);
  });

  it('every labelled skill is a reviewed hard skill or certificate of the fixture vocabulary; one skill never carries two states in a pair', () => {
    for (const p of pairs) {
      const states = new Map<string, string>();
      for (const s of labelsOf(p)) {
        const id = vocabulary.idOf(s.name);
        expect(id, `${p.id} "${s.name}" is not in the vocabulary`).not.toBeNull();
        expect(vocabulary.reviewed(id!), `${p.id} "${s.name}"`).toBe(true);
        expect(vocabulary.kindOf(id!), `${p.id} "${s.name}"`).not.toBe('soft');
        expect(states.get(id!) ?? s.expected, `${p.id} "${s.name}" has two states`).toBe(s.expected);
        states.set(id!, s.expected);
      }
      for (const soft of p.posting.softSkills ?? []) expect(vocabulary.kindOf(vocabulary.idOf(soft) ?? ''), `${p.id} "${soft}"`).toBe('soft');
    }
  });

  it('is built on the role groups of the MKT-1D fixtures', () => {
    const groups = (JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'seed', 'groups.json'), 'utf8')) as { groups: Array<{ groupId: string; roles: Array<{ roleId: string }> }> }).groups;
    const roles = new Map(groups.map((g) => [g.groupId, new Set(g.roles.map((r) => r.roleId))]));
    for (const p of pairs) expect(roles.get(p.basedOn!.groupId)?.has(p.basedOn!.roleId), `${p.id} ${p.basedOn!.groupId}/${p.basedOn!.roleId}`).toBe(true);
    expect(new Set(pairs.map((p) => p.basedOn!.groupId)).size).toBeGreaterThanOrEqual(12);
  });

  it('the vocabulary extension adds to the committed seed and never replaces a skill of it', () => {
    const seed = (JSON.parse(readFileSync(path.join(REPO_ROOT, SEED_FILE), 'utf8')) as { skills: Array<{ id: string }> }).skills;
    const extension = (JSON.parse(readFileSync(path.join(DIR, EXTENSION_FILE), 'utf8')) as { skills: Array<{ id: string; status: string; labelEn: string }> }).skills;
    const seedIds = new Set(seed.map((s) => s.id));
    for (const s of extension) {
      expect(seedIds.has(s.id), `${s.id} is already a seed skill`).toBe(false);
      expect(s.status).toBe('reviewed');
      expect(s.labelEn.trim()).not.toBe('');
    }
    expect(new Set(extension.map((s) => s.id)).size).toBe(extension.length);
    // No name of the extension takes a name the seed already gave to another skill.
    expect((vocabulary as unknown as { conflicts: unknown[] }).conflicts).toEqual([]);
    // The fixture does not reach the product: the process-wide vocabulary is still the committed seed.
    resetVocabularyForTests();
    expect(current().size).toBe(seed.length);
    expect(current().idOf('Model deployment')).toBeNull();
  });

  it('readPairs refuses a file that is not synthetic, a state that is not one of the three and a label without a reason', () => {
    const one = pairs[0]!;
    expect(() => readPairs({ pairs: [one] })).toThrow(/_synthetic/);
    expect(() => readPairs({ _synthetic: true, pairs: [{ ...one, posting: { ...one.posting, skills: [{ name: 'Go', expected: 'missing', reason: 'x' }] } }] })).toThrow(/expected one of shown, related, not_shown/);
    expect(() => readPairs({ _synthetic: true, pairs: [{ ...one, posting: { ...one.posting, skills: [{ name: 'Go', expected: 'shown', reason: ' ' }] } }] })).toThrow(/no reason/);
    expect(() => readPairs({ _synthetic: true, pairs: [{ ...one, subset: 'ja' }] })).toThrow(/subset/);
    expect(readPairs({ _synthetic: true, pairs: [one] })).toEqual([one]);
  });
});

describe('the arithmetic of the suite', () => {
  const c = (expected: Comparison['expected'], predicted: Comparison['predicted']): Comparison => ({ pairId: 'p', subset: 'en', market: 'intl', name: 'x', expected, predicted, reason: 'r' });

  it('precision is over what the check answered, recall over what a person labelled; an unlisted skill is in neither precision', () => {
    const rows = [c('not_shown', 'not_shown'), c('not_shown', 'not_shown'), c('shown', 'not_shown'), c('not_shown', 'unlisted'), c('related', 'related'), c('shown', 'shown')];
    expect(scoreState(rows, 'not_shown')).toEqual({ precision: 2 / 3, recall: 2 / 3, predicted: 3, expected: 3, correct: 2 });
    expect(scoreState(rows, 'related')).toMatchObject({ precision: 1, recall: 1 });
    expect(scoreState(rows, 'shown')).toMatchObject({ precision: 1, recall: 0.5 });
    expect(scoreState([c('shown', 'unlisted')], 'not_shown')).toEqual({ precision: null, recall: null, predicted: 0, expected: 0, correct: 0 });
  });

  it('comparePairs counts a repeated skill, a listed soft skill and a skill labelled twice with two states', () => {
    const pair: SkillsPair = {
      id: 'p1',
      market: 'intl',
      subset: 'en',
      resumeLang: 'en',
      postingLang: 'en',
      resume: { title: 'Engineer', skills: ['Go'], markdown: 'Go' },
      posting: {
        title: 'Engineer',
        softSkills: ['Communication'],
        skills: [
          { name: 'Go', required: true, expected: 'shown', reason: 'listed' },
          { name: 'Golang', required: false, expected: 'not_shown', reason: 'the same skill, labelled differently by mistake' },
          { name: 'Kafka', required: false, expected: 'not_shown', reason: 'absent' },
        ],
      },
    };
    // A check that repeats Go, lists the soft skill and says nothing about Kafka.
    const badCheck = () => [
      { key: 'skills', items: [{ term: 'Go', state: 'shown', skillId: 'go' }, { term: 'Communication', state: 'not_shown', skillId: 'communication' }] },
      { key: 'keywords', items: [{ term: 'Golang', state: 'shown', skillId: 'go' }] },
    ];
    const got = comparePairs([pair], { buildKeywordRows: badCheck, normalizeText: (t) => t.toLowerCase() }, vocabulary, { withIds: true });
    expect(got.duplicates).toEqual([{ pairId: 'p1', term: 'Golang' }]);
    expect(got.softListed).toEqual([{ pairId: 'p1', term: 'Communication' }]);
    expect(got.conflicts).toEqual([{ pairId: 'p1', name: 'Golang' }]);
    expect(got.comparisons.map((x) => [x.name, x.expected, x.predicted])).toEqual([
      ['Go', 'shown', 'shown'],
      ['Kafka', 'not_shown', 'unlisted'],
    ]);
  });
});

describe('the posting row the suite builds is the row enrichment v3 writes', () => {
  const label = (name: string, required = false) => ({ name, required, expected: 'shown' as const, reason: 'listed' });
  const posting: SkillsPair['posting'] = {
    title: 'Backend Engineer',
    softSkills: ['Communication skills', 'Communication'],
    skills: [label('postgres'), label('PostgreSQL', true), label('k8s', true), label('Quantum widgets')],
    keywords: [label('Kafka')],
  };

  it('with ids: one skillsDetail entry per skill under its own label, every spelling in `skills`, hard ids only in skillIds, one keyword per skill', () => {
    const row = postingSkillRow(posting, vocabulary, { withIds: true });
    expect(row.skills).toEqual(['postgres', 'postgresql', 'k8s', 'quantum widgets', 'communication skills', 'communication']);
    expect(row.skillsDetail).toEqual([
      // Two spellings, one entry: shown by the skill's own name, required because one spelling is.
      { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
      // No spelling of the posting is the label: the first one seen.
      { skill: 'k8s', kind: 'hard', required: true, skillId: 'kubernetes', via: 'alias' },
      // A string the vocabulary does not know keeps an entry of its own, without an id.
      { skill: 'quantum widgets', kind: 'hard', required: false, skillId: null, via: 'none' },
      { skill: 'communication', kind: 'soft', required: false, skillId: 'communication', via: 'alias' },
    ]);
    expect(row.skillIds).toEqual(['postgresql', 'kubernetes']);
    expect(row.keywords.slice(0, 2)).toEqual([
      { keyword: 'postgresql', importance: 'high', skillId: 'postgresql' },
      { keyword: 'k8s', importance: 'high', skillId: 'kubernetes' },
    ]);
  });

  it('without ids: one entry per string and no id anywhere', () => {
    const row = postingSkillRow(posting, vocabulary, { withIds: false });
    expect(row.skillIds).toEqual([]);
    expect(row.skillsDetail).toHaveLength(6);
    expect(row.skillsDetail.every((d) => !('skillId' in d))).toBe(true);
    expect(row.keywords.every((k) => !('skillId' in k))).toBe(true);
  });

  it('the check on such a row lists each skill once and nothing as unchecked that is only a second spelling', async () => {
    const seams = await import('../../keywordRows.js');
    const { setVocabularyForTests } = await import('../../../skills/index.js');
    const pair: SkillsPair = {
      id: 'row-1',
      market: 'intl',
      subset: 'en',
      resumeLang: 'en',
      postingLang: 'en',
      resume: { title: 'Backend Engineer', skills: ['PostgreSQL', 'Kubernetes'], markdown: 'PostgreSQL, Kubernetes' },
      posting: { ...posting, skills: posting.skills.slice(0, 3), keywords: [] },
    };
    setVocabularyForTests(vocabulary as never);
    try {
      let rows: Array<{ key: string; items: unknown[]; unchecked?: number }> = [];
      const build = (input: Record<string, unknown>) => (rows = seams.buildKeywordRows(input as never) as never);
      const got = comparePairs([pair], { buildKeywordRows: build as never, normalizeText: seams.normalizeText }, vocabulary, { withIds: true });
      expect(got.comparisons.map((x) => [x.name, x.predicted])).toEqual([
        ['postgres', 'shown'],
        ['k8s', 'shown'],
      ]);
      expect(got.duplicates).toEqual([]);
      expect(got.softListed).toEqual([]);
      const skillsRow = rows.find((r) => r.key === 'skills')!;
      expect(skillsRow.items).toHaveLength(2);
      expect('unchecked' in skillsRow).toBe(false);
    } finally {
      setVocabularyForTests(null);
    }
  });
});

describe('the gate on the committed pairs', () => {
  it('is the skills suite of the harness', () => {
    expect([name, layer]).toEqual(['skills', 'skills']);
    expect(findGate('skills', 'precision_not_shown')!.rule).toEqual({ kind: 'min', threshold: 0.95 });
  });

  it('precision of "Not shown" is at or above 0.95, no skill is listed twice and no soft skill is listed', async () => {
    const m = byMetric(await run(ctx()));
    const gate = findGate('skills', 'precision_not_shown')!;
    expect(compareWithGate(gate, { value: m.precision_not_shown!.value }).status, m.precision_not_shown!.note).toBe('pass');
    expect(m.precision_not_shown).toMatchObject({ market: 'all', labels: 'authored' });
    expect(m.precision_not_shown!.n).toBeGreaterThanOrEqual(150);
    expect(m.duplicate_items!.value, m.duplicate_items!.note).toBe(0);
    expect(m.soft_items_listed!.value, m.soft_items_listed!.note).toBe(0);
    // The other values are reported; none of them is invented when nothing was predicted.
    for (const metric of ['recall_not_shown', 'precision_shown', 'recall_shown', 'precision_related', 'recall_related', 'unlisted_items', 'precision_not_shown_without_ids']) {
      expect(typeof m[metric]!.value, metric).toBe('number');
      expect(m[metric]!.labels, metric).toBe('authored');
    }
    // The note names every miss with the pair and the reason, so a miss can be read without the fixture.
    expect(m.precision_not_shown!.note).toMatch(/100 pairs, \d+ labelled skills; \d+ of \d+ "not shown" answers are right; by language: en /);
  });

  it('holds for each market on its own, and says so with the market', async () => {
    for (const market of ['intl', 'cn'] as const) {
      const m = byMetric(await run(ctx({ markets: [market] })));
      expect(m.precision_not_shown!.market).toBe(market);
      expect(m.precision_not_shown!.value, `${market}: ${m.precision_not_shown!.note}`).toBeGreaterThanOrEqual(0.95);
      expect(m.duplicate_items!.value).toBe(0);
    }
  });

  it('the check never calls a skill "not shown" that the resume lists under the same name', async () => {
    // The plainest promise of the gate, checked without the labels: a posting skill that is, word for word, in the resume's skill list.
    const seams = await import('../../keywordRows.js');
    const { setVocabularyForTests } = await import('../../../skills/index.js');
    setVocabularyForTests(vocabulary as never);
    try {
      const got = comparePairs(pairs, { buildKeywordRows: seams.buildKeywordRows as never, normalizeText: seams.normalizeText }, vocabulary, { withIds: true });
      for (const p of pairs) {
        const listed = new Set(p.resume.skills.map((s) => s.toLowerCase()));
        for (const row of got.comparisons.filter((x) => x.pairId === p.id && listed.has(x.name.toLowerCase()))) expect(row.predicted, `${p.id} ${row.name}`).toBe('shown');
      }
    } finally {
      setVocabularyForTests(null);
    }
  });

  it('releases the vocabulary it pinned: after a run the process reads the committed seed again', async () => {
    resetVocabularyForTests();
    await run(ctx());
    expect(current().idOf('Model deployment')).toBeNull();
    expect(current().idOf('PostgreSQL')).toBe('postgresql');
  });

  it('with no fixture folder it says no_fixture and measures nothing', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'skills-suite-'));
    const out = await run(ctx({ fixturesDir: empty, repoRoot: empty }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ metric: 'precision_not_shown', value: null, status: 'no_fixture' });
  });
});
