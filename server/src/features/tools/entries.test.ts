// @vitest-environment node
//
// FIX-7: the free resume and job check reported "Job title: Not met" for an
// uploaded resume whose current job is that title, and "No dated experience
// found" for ordinary date ranges, because the rows read roles and dates from
// `###` entry headings and an uploaded file has none (entries.ts).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { parseResume, sectionKeyOf } from '../resume/check/resumeText.js';
import { resumeYears } from '../resume/keywords/keywordReport.js';
import { runChecklist, runRequirementRows } from './checks.js';
import { findDateRange, isExperienceHeading, isWorkHeading, withEntryHeadings } from './entries.js';
import { CN_RESUME_MD, DESIGNER_POSTING, DESIGNER_RESUME_INGEST_MD, DESIGNER_RESUME_TEXT, WEAK_RESUME_MD } from './fixtures.js';
import { textToMarkdown } from './parse.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const now = () => NOW;
const row = (rows: Array<{ key: string }>, key: string) => rows.find((r) => r.key === key) as { status: string; params: Record<string, string | number>; detail: string };

describe('the free resume and job check reads an uploaded resume’s roles and dates', () => {
  it('structured-parse markdown (bold role lines): title met, years from the dated roles', async () => {
    const k = await runRequirementRows(DESIGNER_RESUME_INGEST_MD, DESIGNER_POSTING, 'intl', now);
    expect(row(k.rows, 'title').status).toBe('pass');
    const years = row(k.rows, 'years');
    expect(years.status).toBe('pass');
    expect(years.params).toEqual({ required: 5, found: 9 });
    expect(years.detail).not.toMatch(/No dated experience/);
  });

  it('plain-text upload (title line, then a dates line): the same answer', async () => {
    const md = textToMarkdown(DESIGNER_RESUME_TEXT);
    expect(md).toContain('## PROFESSIONAL EXPERIENCE');
    const k = await runRequirementRows(md, DESIGNER_POSTING, 'intl', now);
    expect(row(k.rows, 'title').status).toBe('pass');
    expect(row(k.rows, 'years').params).toEqual({ required: 5, found: 9 });
    expect(row(k.rows, 'education').status).toBe('pass');
  });

  it('months count: Aug 2017 – May 2019, Jun 2019 – Feb 2022 and Mar 2022 – now add up to 9.0, not 9.8', () => {
    const r = parseResume(withEntryHeadings(DESIGNER_RESUME_INGEST_MD));
    expect(resumeYears(r, NOW)).toBe(9);
  });

  it('dated lines of later sections are not work experience (the text pass knows their headings)', async () => {
    const text = [
      'Sam Rivera',
      'sam@example.test',
      '',
      'Work Experience:',
      'Product Designer, Shop Co',
      '2024.01 - Present',
      '• Designed the returns flow',
      '',
      'EDUCATION AND TRAINING',
      'B.A. Design, State University',
      '2013 - 2017',
      '',
      'Volunteer Work',
      'Design mentor, City Library',
      '2010 - 2013',
      '',
      'Licenses & Certifications',
      'Accessibility certificate, 2018 - 2020',
    ].join('\n');
    const md = textToMarkdown(text);
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Work Experience', '## EDUCATION AND TRAINING', '## Volunteer Work', '## Licenses & Certifications']);
    const years = row((await runRequirementRows(md, DESIGNER_POSTING, 'intl', now)).rows, 'years');
    // 2.8 years of work, not 2.8 + 4 + 3 + 2.
    expect(years.params).toEqual({ required: 5, found: 2.8 });
    expect(years.status).toBe('fail');
  });

  it('still says "Not listed" when the resume gives no dates, and "Not met" for another title', async () => {
    const undated = ['# Sam Rivera', '', '## Experience', '', '**Shop Assistant — Shop Co**', '- Helped customers with orders'].join('\n');
    const k = await runRequirementRows(undated, DESIGNER_POSTING, 'intl', now);
    expect(row(k.rows, 'years').status).toBe('unknown');
    expect(row(k.rows, 'years').params).toEqual({ required: 5 });
    expect(row(k.rows, 'title').status).toBe('fail');
  });

  it('a short dated history is a real gap, not a pass', async () => {
    const short = ['# Sam Rivera', '', '## Experience', '', '**Product Designer — Shop Co** · 2024.01 – Present', '- Designed the returns flow'].join('\n');
    const years = row((await runRequirementRows(short, DESIGNER_POSTING, 'intl', now)).rows, 'years');
    expect(years.status).toBe('fail');
    expect(years.params).toEqual({ required: 5, found: 2.8 });
  });

  it('a Chinese resume with dated bold roles is read too', async () => {
    const cn = ['# 李明', '', '## 工作经历', '', '**后端工程师 — 某科技公司** · 2021年7月 - 至今 · 上海', '- 负责接口开发'].join('\n');
    const k = await runRequirementRows(cn, { title: '后端工程师', text: '任职要求：3年以上工作经验，本科及以上学历。' }, 'cn', now);
    expect(row(k.rows, 'title').status).toBe('pass');
    expect(row(k.rows, 'years').params).toEqual({ required: 3, found: 5.3 });
  });

  it('resumes already in the editor shape are untouched (same rows as before)', async () => {
    expect(withEntryHeadings(WEAK_RESUME_MD)).toBe(WEAK_RESUME_MD);
    expect(withEntryHeadings(CN_RESUME_MD)).toBe(CN_RESUME_MD);
  });

  it('the checklist reads the resume as uploaded (the view is for the rows only)', async () => {
    const a = await runChecklist(DESIGNER_RESUME_INGEST_MD, 'intl', now);
    expect(a.issues.every((i) => !JSON.stringify(i).includes('###'))).toBe(true);
  });
});

describe('textToMarkdown keeps a line that begins with a date', () => {
  it('a date is not a numbered bullet; bullets and list numbers still are', () => {
    const md = textToMarkdown(['Sam Rivera', 'Experience', '2024.01 - Present', '2019 – 2022 Shop Co', '1. Designed the returns flow', '2) Trained 4 people', '-Led the stock count', '* Opened the store', '**Shop Assistant**', '-5% shrinkage in 2023', '1、负责接口开发', '• Closed the till', '1.负责接口开发', '2.参与需求评审', '10.Designed the flow', '12.2019 – 03.2022', '3.5 years in retail'].join('\n'));
    expect(md.split('\n')).toEqual([
      '# Sam Rivera',
      '## Experience',
      '2024.01 - Present',
      '2019 – 2022 Shop Co',
      '- Designed the returns flow',
      '- Trained 4 people',
      '- Led the stock count',
      '- Opened the store',
      '**Shop Assistant**',
      '-5% shrinkage in 2023',
      '- 负责接口开发',
      '- Closed the till',
      '- 负责接口开发',
      '- 参与需求评审',
      '- Designed the flow',
      '12.2019 – 03.2022',
      '3.5 years in retail',
    ]);
  });
});

// Review of FIX-7: with roles and dates now read from an uploaded file, a
// dated line that is not a job must never add years (a wrong number shown as
// fact is worse than "Not listed").
describe('only work adds years', () => {
  const JOB = ['EXPERIENCE', 'Designer, Shop Co', '2024.01 - Present', '- Designed the returns flow', ''];
  const yearsOf = async (lines: string[], posting = DESIGNER_POSTING, profile: 'intl' | 'cn' = 'intl') =>
    row((await runRequirementRows(textToMarkdown(lines.join('\n')), posting, profile, now)).rows, 'years');

  it('certificates and affiliations after the jobs are their own sections', async () => {
    const lines = ['Sam Rivera', 'sam@example.test', '', ...JOB, 'CERTIFICATES', 'Google UX Design Certificate', '2019 - 2020', '', 'PROFESSIONAL AFFILIATIONS', 'Member, AIGA', '2012 - Present'];
    const md = textToMarkdown(lines.join('\n'));
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## EXPERIENCE', '## CERTIFICATES', '## PROFESSIONAL AFFILIATIONS']);
    expect(withEntryHeadings(md).split('\n').filter((l) => l.startsWith('### '))).toEqual(['### Designer, Shop Co — 2024.01 – present']);
    const years = await yearsOf(lines);
    expect(years.params).toEqual({ required: 5, found: 2.8 });
    expect(years.status).toBe('fail');
  });

  it.each([
    ['Academic Experience', 'B.A. Design, State University', '2013 - 2017'],
    ['Schooling', 'State University', '2013 - 2017'],
    ['PROFESSIONAL DEVELOPMENT', 'Design leadership programme, City Institute', '2022 - 2023'],
    ['VOLUNTEER EXPERIENCE', 'Design mentor, City Library', '2018 - 2021'],
    ['Leadership Experience', 'President, Design Society', '2015 - 2017'],
    ['Leadership', 'President, Design Society', '2015 - 2017'],
    ['Licenses', 'State contractor licence', '2016 - 2020'],
    ['Memberships', 'Interaction Design Association', '2014 - 2020'],
    ['Courses and Certifications', 'Interaction design foundations', '2018 - 2019'],
    ['Community Involvement', 'Food bank shift lead', '2015 - 2020'],
  ])('"%s" is not years of work', async (heading, entry, dates) => {
    const years = await yearsOf(['Sam Rivera', 'sam@example.test', '', ...JOB, heading, entry, dates]);
    expect(years.params).toEqual({ required: 5, found: 2.8 });
    expect(years.status).toBe('fail');
  });

  it('a Chinese resume: 培训经历, 在校经历 and 社会实践经历 are not jobs', async () => {
    const posting = { title: '后端工程师', text: '任职要求：3年以上工作经验，本科及以上学历。' };
    for (const [heading, entry] of [['培训经历', 'Java 开发培训 某培训机构'], ['在校经历', '学生会 宣传部部长'], ['社会实践经历', '暑期支教 志愿者'], ['志愿者经历', '马拉松志愿者']] as const) {
      const lines = ['李明', '', '工作经历', '后端工程师 某科技公司', '2021年7月 - 至今', '1.负责接口开发', '', heading, entry, '2017年9月 - 2021年6月'];
      const years = await yearsOf(lines, posting, 'cn');
      expect([heading, years.params]).toEqual([heading, { required: 3, found: 5.3 }]);
    }
  });

  it('under a heading the text pass does not know, a degree, a certificate or a membership is still not a job', async () => {
    const lines = [
      'Sam Rivera', 'sam@example.test', '', ...JOB,
      'THINGS I AM PROUD OF',
      'Google UX Design Certificate',
      '2019 - 2020',
      '',
      'B.A. Design, State University',
      '2013 - 2017',
      '',
      'Master of Design — City Institute, 2017 – 2019',
      '',
      'Member, AIGA',
      '2012 - Present',
      '',
      'Student member of the Interaction Design Association (2010 – 2013)',
    ];
    const view = withEntryHeadings(textToMarkdown(lines.join('\n'))).split('\n');
    expect(view.filter((l) => l.startsWith('### '))).toEqual(['### Designer, Shop Co — 2024.01 – present']);
    // The lines are still there, as written.
    for (const kept of ['THINGS I AM PROUD OF', 'Google UX Design Certificate', '2019 - 2020', 'B.A. Design, State University', 'Member, AIGA', '2012 - Present']) expect(view).toContain(kept);
    expect((await yearsOf(lines)).params).toEqual({ required: 5, found: 2.8 });
    // The same for the structured parse's bold lines.
    const bold = ['## Experience', '**Designer — Shop Co** · 2024.01 – Present', '**Google UX Design Certificate — Coursera** · 2019 – 2020', '**Member — AIGA** · 2012 – Present'];
    expect(withEntryHeadings(bold.join('\n')).split('\n')).toEqual(['## Experience', '### Designer — Shop Co — 2024.01 – present', bold[2], bold[3]]);
  });

  it('jobs whose words look like those are still jobs', () => {
    const jobs = [
      'Team Member — Target',
      'Crew Member, Harbor Cafe',
      'Member of Technical Staff — Orbital Systems',
      'Senior Member of Technical Staff, Orbital Systems',
      'Board Member, Riverside Housing Trust',
      'Certified Nursing Assistant — Sunrise Care',
      'Licensed Practical Nurse — Sunrise Care',
      'Scrum Master — Acme, Boston, MA',
      'Master Data Analyst, Acme',
      'MBA Intern — Northwind Capital',
      'Bootcamp Instructor — Code School',
      'Groundskeeper — Pine Hills Golf Course',
      'Designer — Acme, Boston, MA',
      'Designer · Acme · MA, USA',
      'BA Lead — Acme Bank',
      'Research Assistant — State University',
      '会员运营经理 · 某电商公司',
      '英语教师 · 某教育培训',
      '博士后研究员 · 某研究所',
    ];
    for (const job of jobs) {
      const view = withEntryHeadings(['## Experience', job, '2019 - 2022'].join('\n')).split('\n');
      expect([job, view.length, view[1]!.startsWith('### '), view[1]!.endsWith('— 2019 – 2022')]).toEqual([job, 2, true, true]);
    }
  });

  it('an entry is judged by all of its lines, and its neighbours keep theirs', () => {
    const view = (lines: string[]) => withEntryHeadings(['## Experience', ...lines].join('\n')).split('\n').slice(1);
    expect(view(['Designer — Acme', '2019 – 2022', 'Google UX Design Certificate', '2019 - 2020'])).toEqual(['### Designer — Acme — 2019 – 2022', 'Google UX Design Certificate', '2019 - 2020']);
    expect(view(['B.A. Design', 'State University', '2013 - 2017', 'Designer — Acme', '2019 – 2022'])).toEqual(['B.A. Design', 'State University', '2013 - 2017', '### Designer — Acme — 2019 – 2022']);
    expect(view(['Member, AIGA (2012 – Present)', 'Designer — Acme, 2019 – 2022'])).toEqual(['Member, AIGA (2012 – Present)', '### Designer — Acme — 2019 – 2022']);
  });

  it('a label under each job is not a section: later jobs stay in the experience section', async () => {
    const lines = [
      'Sam Rivera', 'sam@example.test', '',
      'EXPERIENCE',
      'Senior Designer — Acme',
      '2020 – Present',
      'Achievements:',
      '- Led the redesign of the tracking dashboard',
      'Product Designer — Beta',
      '2014 – 2020',
      'Achievements:',
      '- Designed the scheduling flow',
      '',
      'EDUCATION',
      'B.A. Design, State University, 2014',
    ];
    const md = textToMarkdown(lines.join('\n'));
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## EXPERIENCE', '## EDUCATION']);
    const k = await runRequirementRows(md, DESIGNER_POSTING, 'intl', now);
    expect(row(k.rows, 'years').params).toEqual({ required: 5, found: 12.8 });
    expect(row(k.rows, 'title').status).toBe('pass');
  });

  it('a label is told from a section by how it is written, and never joins a role heading', () => {
    // Once, with a colon, under a heading that has none: a label.
    const once = textToMarkdown(['Sam Rivera', 'EXPERIENCE', 'Senior Designer — Acme, 2020 – Present', 'Key Projects:', '- Tracking dashboard', 'Product Designer — Beta, 2014 – 2020', '- Scheduling flow'].join('\n'));
    expect(once.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## EXPERIENCE']);
    expect(withEntryHeadings(once).split('\n').filter((l) => l.startsWith('### '))).toEqual(['### Senior Designer — Acme — 2020 – present', '### Product Designer — Beta — 2014 – 2020']);
    // Repeated without a colon, in the heading's own style: still a label, and not part of the role's name.
    const repeated = textToMarkdown(['Sam Rivera', 'Experience', 'Senior Designer — Acme, 2020 – Present', 'Technologies', 'Figma, React', 'Product Designer — Beta, 2014 – 2020', 'Technologies', 'Sketch'].join('\n'));
    expect(repeated.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Experience']);
    expect(withEntryHeadings(repeated).split('\n').filter((l) => l.startsWith('### '))).toEqual(['### Senior Designer — Acme — 2020 – present', '### Product Designer — Beta — 2014 – 2020']);
  });

  it('the same words written as the resume writes its headings are sections', async () => {
    // Every heading has a colon here, so "Projects:" is a heading too, and its dates are not work.
    const colon = ['Sam Rivera', 'sam@example.test', '', 'Experience:', 'Designer, Shop Co', '2024.01 - Present', '', 'Projects:', 'Portfolio site', '2015 - 2020', '', 'Training:', 'Design sprint facilitation, 2012 - 2014'];
    expect(textToMarkdown(colon.join('\n')).split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Experience', '## Projects', '## Training']);
    expect((await yearsOf(colon)).params).toEqual({ required: 5, found: 2.8 });
    const caps = ['Sam Rivera', '', 'EXPERIENCE', 'Designer, Shop Co', '2024.01 - Present', '', 'PROJECTS', 'Portfolio site', '2015 - 2020', '', 'ACHIEVEMENTS', 'Design award, 2019 - 2020'];
    expect(textToMarkdown(caps.join('\n')).split('\n').filter((l) => l.startsWith('## '))).toEqual(['## EXPERIENCE', '## PROJECTS', '## ACHIEVEMENTS']);
    expect((await yearsOf(caps)).params).toEqual({ required: 5, found: 2.8 });
  });
});

describe('withEntryHeadings', () => {
  const view = (lines: string[]) => withEntryHeadings(lines.join('\n')).split('\n');

  it('writes a bold role line as a heading with the dates last', () => {
    expect(view(['## Experience', '', '**Senior Designer — Snowflake** · March 2022 – Present · Remote – US', '- Led the redesign'])).toEqual([
      '## Experience',
      '',
      '### Senior Designer — Snowflake · Remote – US — 2022.03 – present',
      '- Led the redesign',
    ]);
  });

  it('never lets a word of an employer or a place stand in for a date', () => {
    // "Snowflake" holds "now" and "Remote – US" holds a dash: the reader must still get the two dates.
    const r = parseResume(withEntryHeadings(['## Experience', '**Senior Designer — Snowflake** · March 2022 – February 2024 · Remote – US'].join('\n')));
    expect(resumeYears(r, NOW)).toBe(1.9);
    // No dates → no range at all, whatever the words are.
    const undated = parseResume(withEntryHeadings(['## Experience', '**Knowledge Manager — Snowflake**'].join('\n')));
    expect(undated.sections[0]!.entries).toEqual(['Knowledge Manager · Snowflake']);
    expect(resumeYears(undated, NOW)).toBeNull();
  });

  it('joins a dates-only line with the role line above it, and leaves bullets alone', () => {
    expect(view(['## Experience', 'Product Designer — Fernwood Health, Seattle, WA', 'June 2019 – February 2022', '- Designed the scheduling flow', '', 'UX Designer', 'Studio Kestrel, Seattle, WA', '08/2017 - 05/2019'])).toEqual([
      '## Experience',
      '### Product Designer — Fernwood Health, Seattle, WA — 2019.06 – 2022.02',
      '- Designed the scheduling flow',
      '',
      '### UX Designer · Studio Kestrel, Seattle, WA — 2017.08 – 2019.05',
    ]);
  });

  it('reads a dates-first layout and a role line with the dates on it', () => {
    expect(view(['## Work Experience', '2019.06 - 2022.02', 'Product Designer', 'Fernwood Health', '- Designed the flow'])).toEqual([
      '## Work Experience',
      '### Product Designer · Fernwood Health — 2019.06 – 2022.02',
      '- Designed the flow',
    ]);
    expect(view(['## Experience', 'Brightlane Logistics, Inc.', 'Senior Product Designer    Mar 2022 - Present', 'Led the redesign of the shipment tracking dashboard used by more than a thousand dispatchers.'])).toEqual([
      '## Experience',
      '### Brightlane Logistics, Inc. · Senior Product Designer — 2022.03 – present',
      'Led the redesign of the shipment tracking dashboard used by more than a thousand dispatchers.',
    ]);
  });

  it('a sentence next to a dated role line stays body text', () => {
    expect(view(['## Experience', 'Engineer, Beta LLC, 2016-2019', 'Worked on the API.', 'Senior Engineer at Acme (2019 - 2022)', 'Shipped the billing rewrite:'])).toEqual([
      '## Experience',
      '### Engineer, Beta LLC — 2016 – 2019',
      'Worked on the API.',
      '### Senior Engineer at Acme — 2019 – 2022',
      'Shipped the billing rewrite:',
    ]);
  });

  it('two roles on consecutive lines keep their own title lines', () => {
    expect(view(['## Experience', 'Title A — Co A', 'March 2022 – Present', 'Title B — Co B', 'June 2019 – Feb 2022'])).toEqual([
      '## Experience',
      '### Title A — Co A — 2022.03 – present',
      '### Title B — Co B — 2019.06 – 2022.02',
    ]);
  });

  it('touches nothing outside experience sections, and nothing undated', () => {
    const md = ['# Name', 'Senior Designer · 2019 – 2022', '', '## Education', '**State University · 2013 – 2017** — B.A.', '', '## Experience', 'Helped customers every day', '- 2019 – 2022 at the front desk'].join('\n');
    expect(withEntryHeadings(md)).toBe(md);
  });

  it('is idempotent', () => {
    for (const md of [DESIGNER_RESUME_INGEST_MD, textToMarkdown(DESIGNER_RESUME_TEXT)]) {
      const once = withEntryHeadings(md);
      expect(withEntryHeadings(once)).toBe(once);
      expect(once).toContain('### Senior Product Designer — Brightlane Logistics (fictional)');
    }
  });
});

describe('findDateRange', () => {
  const text = (line: string) => findDateRange(line)?.text ?? null;

  it('reads the usual notations', () => {
    expect(text('March 2022 – Present')).toBe('2022.03 – present');
    expect(text('Sept. 2019 - May 2021')).toBe('2019.09 – 2021.05');
    expect(text('Jan 2020 to date')).toBe('2020.01 – present');
    expect(text('06/2019 – 02/2022')).toBe('2019.06 – 2022.02');
    expect(text('2021.09-2022.06')).toBe('2021.09 – 2022.06');
    expect(text('2019-06-01 – 2022-02-28')).toBe('2019.06 – 2022.02');
    expect(text('2017 – 2021')).toBe('2017 – 2021');
    expect(text('2019-2022')).toBe('2019 – 2022');
    expect(text('2021年7月 - 至今')).toBe('2021.07 – present');
    expect(text('2019年6月至2022年2月')).toBe('2019.06 – 2022.02');
    expect(text('2024.07 – 2024.09')).toBe('2024.07 – 2024.09');
  });

  it('one date, a backwards range or other digits are not a range', () => {
    expect(text('Graduated 2017')).toBeNull();
    expect(text('2022 – 2019')).toBeNull();
    expect(text('+1 503 555 0142')).toBeNull();
    expect(text('Grew revenue 2019% - 2022 units')).toBeNull();
    expect(text('WCAG 2.1 AA, 1,200 dispatchers')).toBeNull();
  });
});

describe('isWorkHeading', () => {
  it('is the reader’s experience section, less the ones that are not jobs', () => {
    for (const h of ['Experience', 'PROFESSIONAL EXPERIENCE', 'Work History', 'Employment', 'Internships', 'Research Experience', 'Teaching Experience', 'Additional Experience', 'Professional & Leadership Experience', 'Executive Leadership Experience', '工作经历', '实习经历', '实践经历']) expect([h, isWorkHeading(h)]).toEqual([h, true]);
    for (const h of ['VOLUNTEER EXPERIENCE', 'Volunteering Experience', 'Academic Experience', 'Leadership Experience', 'Community Experience', '社会实践经历', '在校实践经历', '志愿者工作经历', 'Education', 'Career Summary', 'Skills']) expect([h, isWorkHeading(h)]).toEqual([h, false]);
  });
});

describe('isExperienceHeading', () => {
  it('agrees with the resume reader on what an experience section is', () => {
    const headings = ['Experience', 'PROFESSIONAL EXPERIENCE', 'Work History', 'Employment', 'Internships', 'Career Summary', 'Professional Summary', 'Career Profile', 'Education', 'Skills', 'Projects', '工作经历', '实习经历', '教育背景', '個人簡介', '工作經歷', 'Languages'];
    for (const h of headings) expect([h, isExperienceHeading(h)]).toEqual([h, sectionKeyOf(h) === 'experience']);
  });
});
