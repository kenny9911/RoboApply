// @vitest-environment node
// The keyword check with three states (SM-6; MARKET_STRATEGY 2.3 step 5; MATCH 4.6): Shown, Related, Not shown.
// A fixture vocabulary is pinned through the skills test seam; nothing reads a database.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildVocabulary, resetVocabularyForTests, setVocabularyForTests } from '../skills/index.js';
import { KEYWORD_QUOTE_MAX, type KeywordItem, type KeywordRow } from './contract.js';
import { buildKeywordRows, clipQuote, ratioStatus, resumeSentences, vocabularyAsOf, type KeywordInput } from './keywordRows.js';
import { normalizeText, skillsDimension, splitSkills } from './preScore.js';
import { DEFAULT_MATCH_WEIGHTS } from './contract.js';
import { FIXTURE_SKILLS, matchJob, matchUser, skillRecord } from './testkit.js';

beforeEach(() => setVocabularyForTests(FIXTURE_SKILLS));
afterEach(() => resetVocabularyForTests());

type Detail = { skill: string; skillId: string | null; required?: boolean; kind?: string };

/** A posting as enrichment v3 writes it: every skill with the id of its canonical skill. */
function posting(detail: Detail[], more: Parameters<typeof matchJob>[0] = {}) {
  return {
    ...matchJob({
      skills: detail.map((d) => d.skill.toLowerCase()),
      skillsDetail: detail.map((d) => ({ skill: d.skill, kind: d.kind ?? 'hard', required: d.required === true, skillId: d.skillId })),
      skillIds: [...new Set(detail.map((d) => d.skillId).filter((id): id is string => !!id))],
      ...more,
    }),
    minYears: null,
  };
}

function check(job: ReturnType<typeof posting>, resume: { skills?: string[]; text?: string }, keywords: KeywordInput[] | null = null, locale?: string) {
  const text = resume.text ?? '';
  const user = matchUser({ skills: resume.skills ?? [], resumeTextNorm: normalizeText(text) });
  const rows = buildKeywordRows({ job, user, resumeText: text, keywords, locale });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r])) as Record<KeywordRow['key'], KeywordRow>;
  return { rows, skills: byKey.skills, keywords: byKey.keywords, user };
}

const item = (row: KeywordRow, term: string): KeywordItem | undefined => row.items.find((i) => i.term === term);

describe('the three states', () => {
  const job = posting([
    { skill: 'TypeScript', skillId: 'typescript', required: true },
    { skill: 'relational databases', skillId: 'relational_databases', required: true },
    { skill: 'Kubernetes', skillId: 'kubernetes', required: false },
  ]);
  const resume = {
    skills: ['TypeScript', 'PostgreSQL'],
    text: ['## Experience', '- Rewrote the billing service in TypeScript for 40 partner teams.', '- Tuned PostgreSQL queries.', '', '## Skills', 'TypeScript, PostgreSQL'].join('\n'),
  };

  it('shown: the resume names the skill itself, and the item carries the sentence it was found in', () => {
    const { skills } = check(job, resume);
    expect(item(skills, 'TypeScript')).toEqual({
      term: 'TypeScript',
      state: 'shown',
      found: true,
      skillId: 'typescript',
      quote: 'Rewrote the billing service in TypeScript for 40 partner teams.',
      required: true,
    });
  });

  it('ACCEPT: "relational databases" with PostgreSQL on the resume reads related via PostgreSQL, with no quote of its own', () => {
    const { skills } = check(job, resume);
    expect(item(skills, 'Relational databases')).toEqual({
      term: 'Relational databases',
      state: 'related',
      found: true,
      skillId: 'relational_databases',
      via: 'PostgreSQL',
      quote: null,
      required: true,
    });
  });

  it('not shown: neither the skill nor a more specific one', () => {
    const { skills } = check(job, resume);
    expect(item(skills, 'Kubernetes')).toEqual({ term: 'Kubernetes', state: 'not_shown', found: false, skillId: 'kubernetes', quote: null, required: false });
  });

  it('`found` stays for older clients: true for shown and related, false for not shown', () => {
    const { skills } = check(job, resume);
    expect(skills.items.map((i) => [i.state, i.found])).toEqual([
      ['shown', true],
      ['related', true],
      ['not_shown', false],
    ]);
    expect(skills.items.every((i) => (i.state === 'related') === (typeof i.via === 'string'))).toBe(true);
    expect(skills.items.every((i) => i.state === 'shown' || i.quote === null)).toBe(true);
  });

  it('the fit and the check say the same about every skill: one rule', () => {
    const { skills, user } = check(job, resume);
    const split = splitSkills(user, job);
    expect(skills.items.filter((i) => i.found).map((i) => i.term)).toEqual(split.aligned);
    expect(skills.items.filter((i) => i.state === 'related').map((i) => i.term)).toEqual(split.related);
    expect(skills.items.filter((i) => !i.found).map((i) => i.term)).toEqual(split.missing);
    // 1 (required, shown) + 0.5 (required, related) + 0 (preferred) of 1 + 1 + 0.5.
    expect(skillsDimension(user, job, DEFAULT_MATCH_WEIGHTS).score).toBe(60);
  });

  it('a skill from the skill list only is shown without a quote; a title that shows the practice is related', () => {
    const listed = check(job, { skills: ['TypeScript'], text: 'Led a team of four.' });
    expect(item(listed.skills, 'TypeScript')).toMatchObject({ state: 'shown', quote: null });
    // "Software engineering" for a Software Engineer: the title counts, and the item says so.
    setVocabularyForTests([...FIXTURE_SKILLS, skillRecord('software_engineering', 'Software engineering')]);
    const titled = buildKeywordRows({
      job: posting([{ skill: 'software engineering', skillId: 'software_engineering' }]),
      user: matchUser({ skills: [], recentTitle: 'Senior Software Engineer' }),
      resumeText: '',
      keywords: null,
    });
    expect(titled.find((r) => r.key === 'skills')!.items).toEqual([
      { term: 'Software engineering', state: 'related', found: true, skillId: 'software_engineering', via: 'Senior Software Engineer', quote: null, required: false },
    ]);
  });
});

describe('one item per skill, under its usual spelling', () => {
  it('ACCEPT: "Node.js", "node" and "NodeJS" produce one item', () => {
    const job = posting([
      { skill: 'node', skillId: 'nodejs' },
      { skill: 'NodeJS', skillId: 'nodejs', required: true },
      { skill: 'Node.js', skillId: 'nodejs' },
    ]);
    const { skills, keywords } = check(job, { skills: ['nodejs'] }, [
      { keyword: 'Node.js', importance: 'high' },
      { keyword: 'node', importance: 'medium' },
    ]);
    expect(skills.items).toEqual([{ term: 'Node.js', state: 'shown', found: true, skillId: 'nodejs', quote: null, required: true }]);
    expect(keywords.items).toEqual([]);
  });

  it('ACCEPT: the row enrichment v3 writes ("postgres" and "PostgreSQL" in `skills`, one skillsDetail entry) is one item, and nothing is left unchecked', () => {
    const job = {
      ...matchJob({
        skills: ['postgres', 'postgresql', 'communication'],
        skillsDetail: [
          { skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
          { skill: 'communication', kind: 'soft', required: true, skillId: 'communication', via: 'alias' },
        ],
        skillIds: ['postgresql'],
      }),
      minYears: null,
    };
    // Enrichment v3 keeps one keyword per skill of the posting, with its id.
    const asKeywords: KeywordInput[] = [{ keyword: 'postgresql', importance: 'high', skillId: 'postgresql' }];
    const { skills, keywords } = check(job, { skills: ['PostgreSQL'], text: 'Ran Postgres in production for four years.' }, asKeywords);
    expect(skills.items).toEqual([{ term: 'PostgreSQL', state: 'shown', found: true, skillId: 'postgresql', quote: 'Ran Postgres in production for four years.', required: true }]);
    expect(skills).toMatchObject({ status: 'met', found: 1, total: 1 });
    // The second spelling is not a skill "not checked yet", and the soft skill is not listed.
    expect('unchecked' in skills).toBe(false);
    expect(keywords).toMatchObject({ status: 'not_stated', items: [] });

    // Two spellings each of two hard skills and of a soft one: two items, none of them the soft skill as a gap.
    const wide = {
      ...matchJob({
        skills: ['postgres', 'PostgreSQL', 'k8s', 'Kubernetes', 'communication skills', 'Communication'],
        skillsDetail: [
          { skill: 'PostgreSQL', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias' },
          { skill: 'Kubernetes', kind: 'hard', required: true, skillId: 'kubernetes', via: 'alias' },
          { skill: 'Communication', kind: 'soft', required: false, skillId: 'communication', via: 'alias' },
        ],
        skillIds: ['postgresql', 'kubernetes'],
      }),
      minYears: null,
    };
    const got = check(wide, { skills: ['PostgreSQL'] });
    expect(got.skills.items.map((i) => [i.term, i.state])).toEqual([
      ['PostgreSQL', 'shown'],
      ['Kubernetes', 'not_shown'],
    ]);
    expect('unchecked' in got.skills).toBe(false);
    // The fit says the same: one rule.
    expect(splitSkills(got.user, wide)).toMatchObject({ aligned: ['PostgreSQL'], missing: ['Kubernetes'], softSkills: ['Communication'], unchecked: [] });
  });

  it('a keyword already listed as a skill is not repeated, under any spelling; two keywords of one skill are one item', () => {
    const job = posting([{ skill: 'PostgreSQL', skillId: 'postgresql', required: true }]);
    const { skills, keywords, rows } = check(job, { skills: ['Go'] }, [
      { keyword: 'postgres', importance: 'high' },
      { keyword: 'PostgreSQL', importance: 'high', skillId: 'postgresql' },
      { keyword: 'k8s', importance: 'high' },
      { keyword: 'Kubernetes', importance: 'medium' },
      { keyword: 'golang', importance: 'medium', skillId: 'go' },
    ]);
    expect(skills.items.map((i) => i.term)).toEqual(['PostgreSQL']);
    expect(keywords.items.map((i) => [i.term, i.skillId, i.state])).toEqual([
      ['Kubernetes', 'kubernetes', 'not_shown'],
      ['Go', 'go', 'shown'],
    ]);
    const ids = rows.flatMap((r) => r.items.map((i) => i.skillId));
    expect(new Set(ids).size).toBe(ids.length);
    const terms = rows.flatMap((r) => r.items.map((i) => i.term.toLowerCase()));
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('labels follow the reader; Taiwan never gets a Simplified label', () => {
    const job = posting([
      { skill: 'machine learning', skillId: 'machine_learning' },
      { skill: 'CPA', skillId: 'cpa' },
    ]);
    const resume = { skills: ['PostgreSQL', '机器学习'] };
    expect(check(job, resume, null, 'en').skills.items.map((i) => i.term)).toEqual(['Machine learning', 'CPA']);
    expect(check(job, resume, null, 'zh').skills.items.map((i) => i.term)).toEqual(['机器学习', '注册会计师']);
    expect(check(job, resume, null, 'zh-TW').skills.items.map((i) => i.term)).toEqual(['機器學習', 'CPA']);
    // The related skill is named in the reader's language too.
    const related = check(posting([{ skill: 'relational databases', skillId: 'relational_databases' }]), { skills: ['Postgres'] }, null, 'zh-TW');
    expect(related.skills.items).toEqual([{ term: '關聯式資料庫', state: 'related', found: true, skillId: 'relational_databases', via: 'PostgreSQL', quote: null, required: false }]);
  });
});

describe('what is not listed: nothing is claimed or denied about it', () => {
  it('a skill nobody has reviewed, an id the vocabulary does not hold and a string with no id are omitted and counted as unchecked', () => {
    const job = posting([
      { skill: 'TypeScript', skillId: 'typescript', required: true },
      { skill: 'Vertex AI', skillId: 'vertex_ai', required: true },
      { skill: 'Quantum widgets', skillId: 'quantum_widgets' },
      { skill: 'Fast-paced environment', skillId: null },
    ]);
    // Even when the resume names the unreviewed skill, the check says nothing about it: only reviewed skills enter.
    const { skills } = check(job, { skills: ['TypeScript', 'Vertex AI'] });
    expect(skills.items.map((i) => i.term)).toEqual(['TypeScript']);
    expect(skills).toMatchObject({ found: 1, total: 1, status: 'met', unchecked: 3 });
  });

  it('a skill whose id is a machine guess (the nearest vector) is never "not shown": it is left out and counted as unchecked', () => {
    const job = {
      ...matchJob({
        skills: ['typescript', 'container platform'],
        skillsDetail: [
          { skill: 'TypeScript', kind: 'hard', required: true, skillId: 'typescript', via: 'alias' },
          { skill: 'Container platform', kind: 'hard', required: true, skillId: 'kubernetes', via: 'embedding' },
        ],
        skillIds: ['typescript', 'kubernetes'],
      }),
      minYears: null,
    };
    // Enrichment keeps a posting's skills as its keywords too, each with the id it gave the skill.
    const asKeywords: KeywordInput[] = [
      { keyword: 'TypeScript', importance: 'high', skillId: 'typescript' },
      { keyword: 'Container platform', importance: 'high', skillId: 'kubernetes' },
    ];
    const { skills, keywords } = check(job, { skills: [] }, asKeywords);
    expect(skills.items.map((i) => [i.term, i.state])).toEqual([['TypeScript', 'not_shown']]);
    expect(skills.unchecked).toBe(1);
    // The keywords row does not answer for the guess either: nothing says "Kubernetes: not in your resume".
    expect(keywords.items).toEqual([]);
  });

  it('a posting whose skills are all waiting for review is "not checked", never "not stated" and never a miss', () => {
    const job = posting([
      { skill: 'Vertex AI', skillId: 'vertex_ai', required: true },
      { skill: 'Quantum widgets', skillId: 'quantum_widgets' },
    ]);
    const { skills } = check(job, { skills: [] });
    expect(skills).toMatchObject({ status: 'not_checked', items: [], found: null, total: null, unchecked: 2 });
    // A posting that lists no skills at all is "not stated", with no unchecked count.
    const none = check(posting([]), { skills: [] }).skills;
    expect(none).toMatchObject({ status: 'not_stated', items: [] });
    expect('unchecked' in none).toBe(false);
  });

  it('soft skills are never listed, whatever the posting marked them', () => {
    const job = posting([
      { skill: 'TypeScript', skillId: 'typescript' },
      { skill: 'communication skills', skillId: 'communication', kind: 'hard' },
      { skill: 'Team spirit', skillId: null, kind: 'soft' },
    ]);
    const { skills, keywords } = check(job, { skills: [] }, [{ keyword: 'communication', importance: 'high' }]);
    expect(skills.items.map((i) => i.term)).toEqual(['TypeScript']);
    expect(keywords.items).toEqual([]);
    // "Team spirit" is soft, so it is not waiting for review either.
    expect('unchecked' in skills).toBe(false);
  });

  it('a keyword without a reviewed id is not listed: no loose phrase, no generic word, no unreviewed skill', () => {
    const job = posting([{ skill: 'TypeScript', skillId: 'typescript' }]);
    const { keywords } = check(job, { skills: [] }, [
      { keyword: 'shared backend systems', importance: 'high' },
      { keyword: 'software engineering', importance: 'high' },
      { keyword: 'Vertex AI', importance: 'high', skillId: 'vertex_ai' },
      { keyword: 'payments', importance: 'medium' },
      { keyword: 'Kubernetes', importance: 'low' },
      { keyword: 'MySQL', importance: 'medium' },
    ]);
    expect(keywords.items).toEqual([{ term: 'MySQL', state: 'not_shown', found: false, skillId: 'mysql', quote: null }]);
  });

  it('a certificate whose only trace is an abbreviation with another reading is not listed either way', () => {
    const job = posting([
      { skill: 'CPA', skillId: 'cpa', required: true },
      { skill: 'Excel', skillId: 'excel' },
    ]);
    const marketer = check(job, { skills: ['Excel'], text: 'Cut CPA by 20% across paid social.' });
    expect(marketer.skills.items.map((i) => [i.term, i.state])).toEqual([['Excel', 'shown']]);
    expect(marketer.skills.unchecked).toBe(1);
    // Written out, the licence is shown with its sentence; with no trace it is not shown.
    const licensed = check(job, { skills: [], text: 'Certified Public Accountant since 2019. Built models in Excel.' });
    expect(item(licensed.skills, 'CPA')).toMatchObject({ state: 'shown', quote: 'Certified Public Accountant since 2019.' });
    expect(item(check(job, { skills: [], text: 'Managed the quarterly close.' }).skills, 'CPA')).toMatchObject({ state: 'not_shown' });
  });
});

describe('a word with another reading: nothing is claimed, nothing is denied, and its sentence is never quoted', () => {
  const withPhotoshop = () => setVocabularyForTests([...FIXTURE_SKILLS, skillRecord('photoshop', 'Photoshop', { aliases: ['adobe photoshop', 'ps'] })]);
  const job = posting([
    { skill: 'Machine learning', skillId: 'machine_learning', required: true },
    { skill: 'Photoshop', skillId: 'photoshop', required: true },
    { skill: 'Node.js', skillId: 'nodejs', required: true },
    { skill: 'TypeScript', skillId: 'typescript', required: true },
    { skill: 'Excel', skillId: 'excel' },
  ]);
  const NURSE = ['Administered 500 ml of saline per shift.', 'PS: available at once.', 'Looked after a 5-node cluster of beds.', 'Kept the ward rota in Excel.'].join('\n');

  it('"500 ml", "PS:" and "a 5-node cluster" do not show Machine learning, Photoshop or Node.js', () => {
    withPhotoshop();
    const { skills, user } = check(job, { skills: [], text: NURSE });
    expect(skills.items.map((i) => [i.term, i.state, i.quote])).toEqual([
      ['TypeScript', 'not_shown', null],
      ['Excel', 'shown', 'Kept the ward rota in Excel.'],
    ]);
    expect(skills).toMatchObject({ status: 'partly', found: 1, total: 2, unchecked: 3 });
    // No item of either row quotes one of those sentences.
    const quotes = check(job, { skills: [], text: NURSE }, [{ keyword: 'machine learning', importance: 'high', skillId: 'machine_learning' }]).rows.flatMap((r) => r.items.map((i) => i.quote));
    expect(quotes.filter(Boolean)).toEqual(['Kept the ward rota in Excel.']);
    // The fit agrees: not aligned, not missing.
    expect(splitSkills(user, job)).toMatchObject({ aligned: ['Excel'], missing: ['TypeScript'], unchecked: ['Machine learning', 'Photoshop', 'Node.js'] });
  });

  it('a person who lists the skill is shown, and the sentence with the other reading is still not the quote', () => {
    withPhotoshop();
    const { skills } = check(job, { skills: ['Photoshop', 'Machine learning'], text: `${NURSE}\nRetouched product photos in Adobe Photoshop.` });
    expect(item(skills, 'Photoshop')).toMatchObject({ state: 'shown', quote: 'Retouched product photos in Adobe Photoshop.' });
    // Listed only: shown, and "Administered 500 ml of saline" is not offered as the proof.
    expect(item(skills, 'Machine learning')).toMatchObject({ state: 'shown', quote: null });
  });

  it('the posting writes the abbreviation itself: the resume that writes it too is shown, with its sentence', () => {
    const ml = posting([{ skill: 'ML', skillId: 'machine_learning', required: true }]);
    const { skills } = check(ml, { skills: [], text: 'Shipped ML models to production.' });
    expect(skills.items).toEqual([{ term: 'Machine learning', state: 'shown', found: true, skillId: 'machine_learning', quote: 'Shipped ML models to production.', required: true }]);
    // A posting that writes the skill out says nothing about that resume.
    const written = check(posting([{ skill: 'Machine learning', skillId: 'machine_learning', required: true }]), { skills: [], text: 'Shipped ML models to production.' });
    expect(written.skills).toMatchObject({ status: 'not_checked', items: [], unchecked: 1 });
  });

  it('a posting without ids: the same word is left out of the check, never "not in your resume"', () => {
    const legacy = { ...matchJob({ skills: ['machine learning', 'typescript'], skillsDetail: null }), minYears: null };
    const { skills } = check(legacy, { skills: [], text: 'Administered 500 ml of saline per shift.' });
    expect(skills.items.map((i) => [i.term, i.state])).toEqual([['TypeScript', 'not_shown']]);
    expect(skills.unchecked).toBe(1);
  });
});

describe('keywords written before enrichment v3 carry no skill id: they are read as words, never looked up bare', () => {
  it('everyday words of a courier posting are not tech skills "not in your resume"', () => {
    const job = { ...matchJob({ title: 'Courier', skills: [], skillsDetail: null }), minYears: null };
    const words = ['express', 'rest', 'spring', 'go', 'swift', 'shell', 'oracle', 'parcel', 'delivery', 'work day'];
    setVocabularyForTests([
      ...FIXTURE_SKILLS,
      ...['Express', 'REST', 'Spring', 'Swift', 'Oracle'].map((name) => skillRecord(name.toLowerCase(), name, { everydayWord: true })),
      skillRecord('shell', 'Shell scripting', { aliases: ['shell'] }),
      skillRecord('workday', 'Workday', { everydayWord: true }),
    ]);
    const { keywords } = check(job, { skills: ['Driving'], text: 'Delivered parcels by van for six years.' }, words.map((keyword) => ({ keyword, importance: 'high' as const })));
    expect(keywords.items).toEqual([]);
    // The posting does have keywords; none of them could be checked.
    expect(keywords).toMatchObject({ status: 'not_checked', found: null, total: null });
    expect('unchecked' in keywords).toBe(false);
  });

  it('a keyword that names a skill the way a sentence would is listed, under the skill\'s usual spelling', () => {
    const job = { ...matchJob({ skills: [], skillsDetail: null }), minYears: null };
    const { keywords } = check(job, { skills: ['Postgres'], text: 'Ran Kubernetes clusters.' }, [
      { keyword: 'postgres', importance: 'high' },
      { keyword: 'k8s', importance: 'medium' },
      { keyword: 'mysql databases', importance: 'medium' },
      { keyword: 'go', importance: 'high' },
      { keyword: 'golang', importance: 'high' },
    ]);
    expect(keywords.items.map((i) => [i.term, i.skillId, i.state])).toEqual([
      ['PostgreSQL', 'postgresql', 'shown'],
      ['Kubernetes', 'kubernetes', 'shown'],
      ['MySQL', 'mysql', 'not_shown'],
      // "go" alone is a word; "golang" is the language.
      ['Go', 'go', 'not_shown'],
    ]);
    expect(keywords.status).toBe('partly');
  });

  it('a stored id still wins: enrichment v3 says which skill the keyword is', () => {
    const job = posting([{ skill: 'TypeScript', skillId: 'typescript' }]);
    const { keywords } = check(job, { skills: ['Go'] }, [{ keyword: 'go', importance: 'high', skillId: 'go' }]);
    expect(keywords.items).toEqual([{ term: 'Go', state: 'shown', found: true, skillId: 'go', quote: null }]);
  });
});

describe('the keywords row never says "not stated in the post" about a posting that has keywords', () => {
  const job = { ...matchJob({ title: 'Registered Nurse', skills: [], skillsDetail: null }), minYears: null };

  it('keywords, none of them a reviewed skill: not checked', () => {
    const { keywords } = check(job, { skills: [] }, [
      { keyword: 'wound care', importance: 'high' },
      { keyword: 'patient assessment', importance: 'high' },
    ]);
    expect(keywords).toMatchObject({ status: 'not_checked', items: [], found: null, total: null });
  });

  it('an unreviewed skill as a keyword: not checked; no keyword, a low one, a soft one or one the skills row lists: not stated', () => {
    expect(check(job, { skills: [] }, [{ keyword: 'Vertex AI', importance: 'high', skillId: 'vertex_ai' }]).keywords.status).toBe('not_checked');
    expect(check(job, { skills: [] }, null).keywords.status).toBe('not_stated');
    expect(check(job, { skills: [] }, []).keywords.status).toBe('not_stated');
    expect(check(job, { skills: [] }, [{ keyword: 'wound care', importance: 'low' }]).keywords.status).toBe('not_stated');
    expect(check(job, { skills: [] }, [{ keyword: 'communication', importance: 'high', skillId: 'communication' }]).keywords.status).toBe('not_stated');
    const listed = check(posting([{ skill: 'TypeScript', skillId: 'typescript' }]), { skills: [] }, [{ keyword: 'TypeScript', importance: 'high', skillId: 'typescript' }]);
    expect(listed.keywords).toMatchObject({ status: 'not_stated', items: [] });
    // A skill the skills row already counted as unchecked is not counted a second time here.
    const waiting = check(posting([{ skill: 'Vertex AI', skillId: 'vertex_ai' }]), { skills: [] }, [{ keyword: 'Vertex AI', importance: 'high', skillId: 'vertex_ai' }]);
    expect(waiting.skills).toMatchObject({ status: 'not_checked', unchecked: 1 });
    expect(waiting.keywords.status).toBe('not_stated');
    // One listed keyword and one that cannot be checked: the row is about the one it lists.
    const mixed = check(job, { skills: [] }, [
      { keyword: 'MySQL', importance: 'high' },
      { keyword: 'wound care', importance: 'high' },
    ]);
    expect(mixed.keywords).toMatchObject({ status: 'not_met', found: 0, total: 1 });
  });

  it('a string a reviewer ruled is not a skill is no keyword at all', () => {
    setVocabularyForTests(buildVocabulary(FIXTURE_SKILLS, { droppedKeys: ['fastpacedenvironment'] }));
    expect(check(job, { skills: [] }, [{ keyword: 'fast-paced environment', importance: 'high' }]).keywords.status).toBe('not_stated');
  });
});

describe('the quote: the resume sentence the term was found in, verbatim', () => {
  const job = posting([
    { skill: 'Kubernetes', skillId: 'kubernetes' },
    { skill: 'Go', skillId: 'go' },
    { skill: 'machine learning', skillId: 'machine_learning' },
  ]);

  it('English: the sentence, without the markdown markup of the resume', () => {
    const text = ['## Experience', '- **Ran** our `Kubernetes` clusters across three regions. Wrote services in Go; mentored two engineers.', '## Skills', 'Go, Kubernetes, Python'].join('\n');
    const { skills } = check(job, { skills: [], text });
    expect(item(skills, 'Kubernetes')!.quote).toBe('Ran our Kubernetes clusters across three regions.');
    // A sentence is preferred to the skills line, and a clause ends at its semicolon.
    expect(item(skills, 'Go')!.quote).toBe('Wrote services in Go');
    expect(item(skills, 'Machine learning')).toMatchObject({ state: 'not_shown', quote: null });
  });

  it('the skills line is the quote when no sentence names the skill', () => {
    const { skills } = check(job, { skills: [], text: '## Skills\nGo, Kubernetes, Python' });
    expect(item(skills, 'Kubernetes')!.quote).toBe('Go, Kubernetes, Python');
  });

  it('Chinese: found inside a sentence, cut at the Chinese full stop; an alias and the other script count', () => {
    const text = '## 工作经历\n负责推荐系统的机器学习模型训练与上线。使用Go开发后端服务；维护K8s集群。';
    const { skills } = check(job, { skills: [], text });
    expect(item(skills, 'Machine learning')).toMatchObject({ state: 'shown', quote: '负责推荐系统的机器学习模型训练与上线。' });
    expect(item(skills, 'Go')).toMatchObject({ state: 'shown', quote: '使用Go开发后端服务' });
    expect(item(skills, 'Kubernetes')).toMatchObject({ state: 'shown', quote: '维护K8s集群。' });
    // A resume in Traditional Chinese shows the same skill: the names are one key.
    const tw = check(job, { skills: [], text: '負責推薦系統的機器學習模型訓練。' }, null, 'zh-TW');
    expect(item(tw.skills, '機器學習')).toMatchObject({ state: 'shown', quote: '負責推薦系統的機器學習模型訓練。' });
  });

  it(`is at most ${KEYWORD_QUOTE_MAX} characters, a verbatim piece of the sentence that still holds the term`, () => {
    const long = `Over six years I led the platform group through three reorganisations, two data centre moves and one cloud migration, and in the last of those I ran our Kubernetes clusters for every product team, ${'while keeping the lights on '.repeat(6)}every day`;
    const { skills } = check(job, { skills: [], text: long });
    const quote = item(skills, 'Kubernetes')!.quote!;
    expect([...quote].length).toBeLessThanOrEqual(KEYWORD_QUOTE_MAX);
    expect(long).toContain(quote);
    expect(quote).toContain('Kubernetes');
    // A short sentence is returned whole; a long one whose term cannot be placed is not quoted at all.
    expect(clipQuote('Ran Kubernetes.', 'kubernetes')).toBe('Ran Kubernetes.');
    expect(clipQuote('x'.repeat(300), 'kubernetes')).toBeNull();
    expect(clipQuote(`${'a '.repeat(120)}Kubernetes`, 'Kubernetes')!.endsWith('Kubernetes')).toBe(true);
  });

  it('resumeSentences: one per line, prose cut at its full stops, never inside "Node.js"', () => {
    expect(resumeSentences('# Ada\n\n- Built APIs in Node.js and Go. Shipped weekly!\n* Second line; third clause\n负责A。负责B！')).toEqual([
      'Ada',
      'Built APIs in Node.js and Go.',
      'Shipped weekly!',
      'Second line',
      'third clause',
      '负责A。',
      '负责B！',
    ]);
  });
});

describe('a posting that carries no ids yet: the string rule stays, and the vocabulary says what is one skill', () => {
  const legacy = (skills: string[], detail: Array<{ skill: string; kind?: string; required: boolean }> | null = null) => ({ ...matchJob({ skills, skillsDetail: detail }), minYears: null });

  it('INV-7: PostgreSQL is related evidence for "relational databases", and the two spellings of PostgreSQL are one item', () => {
    const job = legacy(
      ['relational databases', 'postgresql', 'postgres', 'typescript'],
      [
        { skill: 'Relational databases', kind: 'hard', required: true },
        { skill: 'PostgreSQL', kind: 'hard', required: false },
        { skill: 'Postgres', kind: 'hard', required: false },
        { skill: 'TypeScript', kind: 'hard', required: true },
      ],
    );
    const { skills, keywords } = check(job, { skills: ['TypeScript', 'Go', 'PostgreSQL'] }, [
      { keyword: 'relational databases', importance: 'high' },
      { keyword: 'PostgreSQL', importance: 'high' },
      { keyword: 'payments', importance: 'medium' },
    ]);
    expect(skills.items.map((i) => [i.term, i.state, i.via ?? null, i.skillId])).toEqual([
      ['Relational databases', 'related', 'PostgreSQL', 'relational_databases'],
      ['TypeScript', 'shown', null, 'typescript'],
      ['PostgreSQL', 'shown', null, 'postgresql'],
    ]);
    expect(keywords.items).toEqual([]);
  });

  it('a string the vocabulary does not know is compared as before: listed, shown or not, with the technology that counted', () => {
    const job = legacy(['distributed tracing', 'incident response', 'typescript/node.js', 'typescript', 'node.js']);
    const { skills } = check(job, { skills: ['TypeScript', 'Node.js'], text: 'Ran incident response for the payments team.' });
    expect(skills.items).toEqual([
      { term: 'Distributed tracing', state: 'not_shown', found: false, skillId: null, quote: null, required: false },
      { term: 'Incident response', state: 'shown', found: true, skillId: null, quote: 'Ran incident response for the payments team.', required: false },
      { term: 'TypeScript', state: 'shown', found: true, skillId: 'typescript', quote: null, required: false },
      { term: 'Node.js', state: 'shown', found: true, skillId: 'nodejs', quote: null, required: false },
    ]);
    expect('unchecked' in skills).toBe(false);
  });

  it('the vocabulary also answers for a string it knows: another script or another spelling is not "not shown"', () => {
    const job = legacy(['machine learning', 'k8s', 'mysql']);
    const { skills, user } = check(job, { skills: ['机器学习', 'Kubernetes'] });
    expect(skills.items.map((i) => [i.term, i.state])).toEqual([
      ['Machine learning', 'shown'],
      ['Kubernetes', 'shown'],
      ['MySQL', 'not_shown'],
    ]);
    // The estimate of such a posting stays on the string rule until it is re-enriched, number and words alike.
    expect(skillsDimension(user, job, DEFAULT_MATCH_WEIGHTS).score).toBe(0);
    expect(splitSkills(user, job)).toMatchObject({ aligned: [], missing: ['Machine learning', 'K8s', 'MySQL'] });
  });

  it('soft skills leave the skills row, by the posting\'s mark or by the vocabulary', () => {
    const job = legacy(
      ['typescript', 'communication', 'ownership'],
      [
        { skill: 'TypeScript', kind: 'hard', required: true },
        { skill: 'Communication', kind: 'hard', required: false },
        { skill: 'Ownership', kind: 'soft', required: false },
      ],
    );
    expect(check(job, { skills: ['TypeScript'] }).skills.items.map((i) => i.term)).toEqual(['TypeScript']);
  });
});

describe('row status: a shown item counts 1, a related one 0.5', () => {
  it('ratioStatus', () => {
    expect(ratioStatus(0, 0)).toBe('not_stated');
    expect(ratioStatus(3, 3)).toBe('met');
    expect(ratioStatus(2.5, 3)).toBe('partly');
    expect(ratioStatus(1.5, 3)).toBe('partly');
    expect(ratioStatus(1, 3)).toBe('not_met');
    expect(ratioStatus(0, 2)).toBe('not_met');
  });

  it.each([
    // [what the person lists, status, found, total]
    [['PostgreSQL', 'TypeScript', 'Kubernetes'], 'partly', 3, 3], // 1 related + 2 shown = 2.5 of 3
    [['Relational databases', 'TypeScript', 'Kubernetes'], 'met', 3, 3],
    [['PostgreSQL'], 'not_met', 1, 3], // 0.5 of 3
    [['PostgreSQL', 'TypeScript'], 'partly', 2, 3], // 1.5 of 3
    [[], 'not_met', 0, 3],
  ])('%j → %s', (skills, status, found, total) => {
    const job = posting([
      { skill: 'relational databases', skillId: 'relational_databases' },
      { skill: 'TypeScript', skillId: 'typescript' },
      { skill: 'Kubernetes', skillId: 'kubernetes' },
    ]);
    expect(check(job, { skills: skills as string[] }).skills).toMatchObject({ status, found, total });
  });

  it('all related is half: partly, never met', () => {
    const job = posting([
      { skill: 'relational databases', skillId: 'relational_databases' },
      { skill: 'frontend frameworks', skillId: 'frontend_frameworks' },
    ]);
    expect(check(job, { skills: ['MySQL', 'React'] }).skills).toMatchObject({ status: 'partly', found: 2, total: 2 });
  });
});

describe('title, years and education rows', () => {
  it('the title row compares the posting with the roles the person\'s record shows, never with the saved search', () => {
    const job = posting([]);
    const rows = (user: ReturnType<typeof matchUser>) => buildKeywordRows({ job, user, resumeText: '', keywords: null });
    const title = (user: ReturnType<typeof matchUser>) => rows(user).find((r) => r.key === 'title')!;
    expect(title(matchUser())).toMatchObject({ status: 'met', need: 'Backend Engineer', have: 'Software Engineer' });
    // No role on the record: unknown, and the saved search's title is not shown as "your recent title".
    const noRecord = matchUser({ evidenceRoleIds: [], recentTitle: null, targetTitles: ['Backend Engineer'], targetTaxonomyIds: ['backend_engineer'] });
    expect(title(noRecord)).toMatchObject({ status: 'unknown', have: null });
  });
});

describe('which vocabulary answered', () => {
  it('vocabularyAsOf: null while only the committed seed is loaded, else the time the table was read', () => {
    resetVocabularyForTests();
    expect(vocabularyAsOf()).toBeNull();
    const at = new Date('2026-10-11T08:00:00.000Z');
    setVocabularyForTests(buildVocabulary(FIXTURE_SKILLS, { asOf: at, source: 'database' }));
    expect(vocabularyAsOf()).toBe('2026-10-11T08:00:00.000Z');
  });
});
