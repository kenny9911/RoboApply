// @vitest-environment node
//
// WP-36a acceptance: claims extraction (every inserted keyword, number or
// statement not in the base resume is pending; a pure rewording is not a
// claim; posting text is never the candidate's own) and the Verify details
// decisions. Also the section merge (header and sensitive lines are put back,
// only picked sections change, entry lines never change) and the line diff.

import { describe, expect, it } from 'vitest';
import { applyClaimDecision, ClaimDecisionError, copiesPosting, extractClaims, pendingCount } from './claims.js';
import { contentUnits, diffChanges, MAX_CHANGES, mergeTailored, similarity, splitBlocks } from './blocks.js';

const BASE = [
  '# Sam Lee',
  '*sam@example.test · +1 415 555 0100 · Oakland, CA*',
  '',
  '## Summary',
  'Data analyst with SQL and Excel experience.',
  '',
  '## Experience',
  '### Bright Retail · Data Analyst · 2021 – present',
  '- Built weekly sales reports in SQL for 12 stores.',
  '- Cleaned inventory data in Excel.',
  '',
  '## Skills',
  'SQL, Excel',
  '',
  '## Education',
  '### State University · BA Economics · 2017 – 2021',
  '',
].join('\n');

/** What the model sees and answers: no name or contact block. */
const TAILORED = [
  '## Summary',
  'Data analyst who turns SQL reporting into decisions for retail teams.',
  '',
  '## Experience',
  '### Bright Retail · Senior Data Analyst · 2019 – present',
  '- Built weekly sales reports in SQL for 12 stores, used by regional managers.',
  '- Cleaned inventory data in Excel and Python.',
  '- Cut report time by 40% with automated dashboards.',
  '- Partnered with Acme Analytics product teams on forecasting models and experimentation platforms.',
  '',
  '## Skills',
  'SQL, Excel, Python, Tableau',
  '',
  '## Education',
  '### State University · BA Economics · 2017 – 2021',
  '',
].join('\n');

const ALL = ['summary', 'experience', 'skills', 'projects', 'education'] as const;

describe('mergeTailored', () => {
  it('puts the header back and keeps entry lines (employer · title · dates) unchanged', () => {
    const md = mergeTailored(BASE, TAILORED, ALL);
    expect(md.startsWith('# Sam Lee\n*sam@example.test')).toBe(true);
    expect(md).toContain('### Bright Retail · Data Analyst · 2021 – present');
    expect(md).not.toContain('Senior Data Analyst');
    expect(md).toContain('Cut report time by 40%');
  });

  it('changes only the picked sections', () => {
    const md = mergeTailored(BASE, TAILORED, ['skills']);
    expect(md).toContain('SQL, Excel, Python, Tableau');
    expect(md).toContain('Data analyst with SQL and Excel experience.');
    expect(md).not.toContain('Cut report time');
  });

  it('keeps sensitive lines of a replaced section (they never reached the prompt)', () => {
    const base = '# 张三\n## 基本信息\n政治面貌：团员\n## 自我评价\n籍贯：浙江\n热爱数据分析。\n';
    const md = mergeTailored(base, '## 自我评价\n热爱数据分析，熟悉SQL。\n', ['summary']);
    expect(md).toContain('政治面貌：团员');
    expect(md).toContain('籍贯：浙江');
    expect(md).toContain('热爱数据分析，熟悉SQL。');
  });

  it('adds a summary the base did not have, after the header', () => {
    const base = '# Sam\n## Experience\n- Built reports.\n';
    const md = mergeTailored(base, '## Summary\nAnalyst.\n## Experience\n- Built reports.\n', ['summary']);
    const blocks = splitBlocks(md);
    expect(blocks.map((b) => b.key)).toEqual(['header', 'summary', 'experience']);
  });

  it('drops an invented employer entry', () => {
    const md = mergeTailored(BASE, TAILORED.replace('## Skills', '### Fake Corp · CTO · 2015 – 2016\n- Ran everything.\n\n## Skills'), ALL);
    expect(md).not.toContain('Fake Corp');
  });
});

describe('diffChanges', () => {
  it('pairs rewrites with the nearest base line and lists additions and removals', () => {
    const merged = mergeTailored(BASE, TAILORED, ALL);
    const changes = diffChanges(BASE, merged);
    expect(changes).toContainEqual(
      expect.objectContaining({ kind: 'rewrite', before: 'Cleaned inventory data in Excel.', after: 'Cleaned inventory data in Excel and Python.' }),
    );
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'add', before: '', after: 'Cut report time by 40% with automated dashboards.' }));
    expect(changes.some((c) => c.section === 'Education')).toBe(false);
  });

  it('ignores reordered lines', () => {
    const a = '## Experience\n- One thing done.\n- Two things done.\n';
    const b = '## Experience\n- Two things done.\n- One thing done.\n';
    expect(diffChanges(a, b)).toEqual([]);
  });

  it('is uncapped by default; the display cap is opt-in', () => {
    const base = '## Experience\n- Built reports.\n';
    const result = `## Experience\n- Built reports.\n${Array.from({ length: 70 }, (_, i) => `- Shipped project ${i + 1} on time.`).join('\n')}\n`;
    expect(diffChanges(base, result)).toHaveLength(70);
    expect(diffChanges(base, result, '', MAX_CHANGES)).toHaveLength(MAX_CHANGES);
  });

  it('reports a removed line', () => {
    expect(diffChanges('## Skills\n- SQL\n- Excel\n', '## Skills\n- SQL\n')).toEqual([{ section: 'Skills', before: 'Excel', after: '', kind: 'remove' }]);
  });
});

describe('extractClaims', () => {
  const merged = mergeTailored(BASE, TAILORED, ALL);
  const claims = extractClaims({
    baseMarkdown: BASE,
    resultMarkdown: merged,
    jobTerms: ['Tableau', 'forecasting'],
    confirmedKeywords: ['Python'],
    posting: { company: 'Acme Analytics', text: 'We are hiring a data analyst to build dashboards in Tableau.' },
  });
  const byText = (s: string) => claims.find((c) => c.text.includes(s));

  it('every claim starts pending', () => {
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.status === 'pending')).toBe(true);
    expect(pendingCount(claims)).toBe(claims.length);
  });

  it('an inserted number is a number claim (CitationGuard)', () => {
    const c = byText('Cut report time')!;
    expect(c.reasons).toContain('new_number');
    expect(c.terms).toContain('40');
  });

  it('an inserted keyword is a keyword claim, even one the user confirmed', () => {
    const skills = byText('Tableau')!;
    expect(skills.kind).toBe('keyword');
    expect(skills.terms).toEqual(expect.arrayContaining(['Tableau', 'Python']));
    expect(skills.original).toBe('SQL, Excel');
    const py = byText('Excel and Python')!;
    expect(py.reasons).toEqual(['new_keyword']);
    expect(py.original).toBe('Cleaned inventory data in Excel.');
  });

  it('the employer from the posting is never the candidate fact: posting_text claim', () => {
    const c = byText('Acme Analytics')!;
    expect(c.kind).toBe('claim');
    expect(c.reasons).toContain('posting_text');
  });

  it('a new statement without numbers or keywords is still a claim', () => {
    const c = byText('regional managers')!;
    expect(c.reasons).toContain('new_statement');
  });

  it('a pure rewording is not a claim', () => {
    const base = '## Experience\n- Built weekly sales reports in SQL.\n';
    const result = '## Experience\n- Built SQL weekly sales reports.\n';
    expect(extractClaims({ baseMarkdown: base, resultMarkdown: result })).toEqual([]);
  });

  it('a number already in the base resume is not a claim', () => {
    const base = '## Experience\n- Managed 12 stores.\n';
    const result = '## Experience\n- Managed twelve stores.\n';
    expect(extractClaims({ baseMarkdown: base, resultMarkdown: result })).toEqual([]);
  });

  it('copies of the posting are found by a run of words', () => {
    expect(copiesPosting('Build dashboards in Tableau for a data analyst team', 'to build dashboards in Tableau for a data team', '')).toBe(true);
    expect(copiesPosting('Built dashboards', 'to build dashboards in Tableau for a data team', '')).toBe(false);
  });

  it('every invented line is a claim, past the 60-change display cap', () => {
    const base = ['## Experience', '### Bright Retail · Data Analyst · 2021 – present', ...Array.from({ length: 40 }, (_, i) => `- Owned report ${i + 1}.`), ''].join('\n');
    // A full rewrite: 40 removals fill most of the display list first…
    const result = ['## Experience', '### Bright Retail · Data Analyst · 2021 – present', ...Array.from({ length: 70 }, (_, i) => `- Raised conversion by ${i + 101}% for partner ${i + 1}.`), ''].join('\n');
    const claims = extractClaims({ baseMarkdown: base, resultMarkdown: result });
    expect(claims).toHaveLength(70);
    expect(claims.every((c) => c.reasons?.includes('new_number'))).toBe(true);
    expect(claims.at(-1)!.text).toBe('Raised conversion by 170% for partner 70.');
  });

  it('the same invented line under two employers is one claim with two copies', () => {
    const base = ['## Experience', '### Acme · Analyst · 2021 – present', '- Built reports.', '### Beta · Analyst · 2019 – 2021', '- Cleaned data.', ''].join('\n');
    const result = ['## Experience', '### Acme · Analyst · 2021 – present', '- Built reports.', '- Managed a team of 12 engineers.', '### Beta · Analyst · 2019 – 2021', '- Cleaned data.', '- Managed a team of 12 engineers.', ''].join('\n');
    const claims = extractClaims({ baseMarkdown: base, resultMarkdown: result });
    expect(claims).toHaveLength(1);
    expect(claims[0]!.copies).toHaveLength(2);
  });

  it('CJK: an inserted skill and number are claims', () => {
    const base = '## 工作经历\n- 负责门店销售数据整理。\n';
    const result = '## 工作经历\n- 负责门店销售数据整理，使用机器学习提升效率30%。\n';
    const c = extractClaims({ baseMarkdown: base, resultMarkdown: result });
    expect(c).toHaveLength(1);
    expect(c[0]!.reasons).toEqual(expect.arrayContaining(['new_number', 'new_keyword']));
  });
});

describe('applyClaimDecision', () => {
  const merged = mergeTailored(BASE, TAILORED, ALL);
  const claims = extractClaims({ baseMarkdown: BASE, resultMarkdown: merged, jobTerms: ['Tableau'], confirmedKeywords: ['Python'], posting: { company: 'Acme Analytics' } });
  const get = (s: string) => claims.find((c) => c.text.includes(s))!;

  it('kept: only the status changes', () => {
    const r = applyClaimDecision(merged, get('Cut report time'), { status: 'kept' });
    expect(r.markdown).toBe(merged);
    expect(r.claim.status).toBe('kept');
  });

  it('removed: a rewritten line goes back to the base line', () => {
    const r = applyClaimDecision(merged, get('Excel and Python'), { status: 'removed' });
    expect(r.markdown).toContain('- Cleaned inventory data in Excel.');
    expect(r.markdown).not.toContain('Excel and Python');
    expect(r.claim.status).toBe('removed');
  });

  it('removed: a new line is deleted', () => {
    const r = applyClaimDecision(merged, get('Cut report time'), { status: 'removed' });
    expect(r.markdown).not.toContain('Cut report time');
  });

  it('removed: a new list line loses only the new terms', () => {
    const md = '## Skills\nSQL, Excel, Tableau\n';
    const claim = { id: 'c1', text: 'SQL, Excel, Tableau', kind: 'keyword' as const, status: 'pending' as const, terms: ['Tableau'], original: null };
    expect(applyClaimDecision(md, claim, { status: 'removed' }).markdown).toContain('SQL, Excel\n');
  });

  it('edited: the user text replaces the line and the AI text is kept for the record', () => {
    const c = get('Cut report time');
    const r = applyClaimDecision(merged, c, { status: 'edited', text: 'Automated two dashboards.' });
    expect(r.markdown).toContain('- Automated two dashboards.');
    expect(r.claim).toMatchObject({ status: 'edited', text: 'Automated two dashboards.', proposed: c.text });
  });

  describe('a line the AI wrote more than once', () => {
    const base = ['## Experience', '### Acme · Analyst · 2021 – present', '- Built reports.', '### Beta · Analyst · 2019 – 2021', '- Cleaned data in Excel.', ''].join('\n');
    const result = [
      '## Experience',
      '### Acme · Analyst · 2021 – present',
      '- Built reports.',
      '- Managed a team of 12 engineers.',
      '### Beta · Analyst · 2019 – 2021',
      '- Managed a team of 12 engineers.',
      '',
    ].join('\n');
    const [dup] = extractClaims({ baseMarkdown: base, resultMarkdown: result });

    it('removed: no copy remains', () => {
      expect(dup!.copies).toHaveLength(2);
      const r = applyClaimDecision(result, dup!, { status: 'removed' });
      expect(r.markdown).not.toContain('Managed a team of 12 engineers');
      expect(r.markdown).toContain('- Built reports.\n### Beta');
      expect(pendingCount([r.claim])).toBe(0);
    });

    it('removed: each copy that replaced a base line gets its own base line back', () => {
      const md = '## Experience\n### Acme\n- Led a team of 12.\n### Beta\n- Led a team of 12.\n';
      const claim = {
        id: 'c1',
        text: 'Led a team of 12.',
        kind: 'number' as const,
        status: 'pending' as const,
        original: 'Led a team.',
        copies: [
          { section: 'Experience', original: 'Led a team.' },
          { section: 'Experience', original: 'Led a small group.' },
        ],
      };
      const r = applyClaimDecision(md, claim, { status: 'removed' });
      expect(r.markdown).toBe('## Experience\n### Acme\n- Led a team.\n### Beta\n- Led a small group.\n');
    });

    it('edited: the user text replaces every copy, so no AI wording survives', () => {
      const r = applyClaimDecision(result, dup!, { status: 'edited', text: 'Mentored two new analysts.' });
      expect(r.markdown).not.toContain('Managed a team of 12 engineers');
      expect(r.markdown.match(/- Mentored two new analysts\./g)).toHaveLength(2);
    });

    it('removed after an edit still removes every copy', () => {
      const edited = applyClaimDecision(result, dup!, { status: 'edited', text: 'Mentored two new analysts.' });
      const r = applyClaimDecision(edited.markdown, edited.claim, { status: 'removed' });
      expect(r.markdown).not.toContain('Mentored');
      expect(r.markdown).not.toContain('Managed a team');
    });
  });

  it('a removed claim is final; a line that changed is a conflict', () => {
    const removed = { ...get('Cut report time'), status: 'removed' as const };
    expect(() => applyClaimDecision(merged, removed, { status: 'kept' })).toThrow(ClaimDecisionError);
    expect(() => applyClaimDecision('## X\n- other\n', get('Cut report time'), { status: 'removed' })).toThrow(ClaimDecisionError);
  });
});

describe('units', () => {
  it('Latin words and CJK bigrams', () => {
    expect([...contentUnits('Built the SQL reports 数据分析')]).toEqual(expect.arrayContaining(['built', 'sql', 'reports', '数据', '据分', '分析']));
    expect(similarity('Built reports in SQL', 'Built SQL reports')).toBeGreaterThan(0.5);
  });
});
