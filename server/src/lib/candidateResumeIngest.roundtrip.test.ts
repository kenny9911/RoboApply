// @vitest-environment node
//
// The stored markdown of an uploaded resume, through the editor's parser.
//
// Opening an uploaded resume used to rewrite it: the editor's parser did not
// know the upload format, so skills lost their labels ("** Zendesk"), role
// lines came back with the dates in the company slot, education printed
// "2020** — B.S.", and the editor then saved that with no user edit. These
// tests feed real `parsedResumeToMarkdown` output to lib/resumeStructure and
// require that nothing is lost and that one save is a fixed point.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/PDFService.js', () => ({ pdfService: {} }));
vi.mock('../services/DocumentParsingService.js', () => ({ documentParsingService: {}, DocumentParsingService: class {} }));
vi.mock('../agents/ResumeParseAgent.js', () => ({ resumeParseAgent: {} }));
vi.mock('../services/GoHireResumeParseService.js', () => ({ goHireResumeParseService: {} }));
vi.mock('../services/ResumeSummaryService.js', () => ({ generateResumeSummaryHighlight: vi.fn() }));
vi.mock('../services/ResumeParserService.js', () => ({ normalizeExtractedText: (s: string) => s }));
vi.mock('../services/ResumeOriginalFileStorageService.js', () => ({ resumeOriginalFileStorageService: {} }));
vi.mock('../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { parsedResumeToMarkdown, resumeDocLanguage } from './candidateResumeIngest.js';
import { parseResumeMarkdown, serializeResumeMarkdown } from '../../../lib/resumeStructure.js';
import { parseResumeMarkdown as exportBlocks } from '../roboapply/v2/lib/resumeExport.js';
import { parseResume } from '../features/resume/check/resumeText.js';
import type { ParsedResume } from '../types/index.js';

const MAYA: ParsedResume = {
  name: 'Maya Lindqvist',
  email: 'maya.lindqvist@example.com',
  phone: '(555) 010-0142',
  address: 'Portland, OR',
  summary: 'Data analyst with 4 years of experience turning operations data into dashboards and forecasts for logistics teams.',
  skills: {
    technical: ['SQL', 'PostgreSQL', 'Python (pandas, numpy)', 'Tableau', 'Excel', 'A/B testing'],
    frameworks: ['pandas'],
    tools: ['Zendesk', 'Jira'],
    languages: ['SQL'],
    soft: ['Stakeholder communication'],
  },
  experience: [
    {
      role: 'Data Analyst',
      company: 'Northwind Freight',
      duration: 'June 2022 – Present',
      location: 'Portland, OR',
      achievements: [
        'Built a weekly on-time delivery dashboard in Tableau used by 12 dispatch managers.',
        'Automated a monthly cost report in Python (pandas), saving about 6 hours a month.',
      ],
    },
    {
      role: 'Junior Analyst',
      company: 'Harbor Lane Grocers',
      duration: 'July 2020 – May 2022',
      location: 'Salem, OR',
      achievements: ['Maintained Excel sales reports for 8 stores.'],
    },
  ],
  projects: [{ name: 'Route planner', role: 'Author', date: '2021', description: 'A small route planner for a food bank.', technologies: ['Python', 'OR-Tools'] }],
  education: [{ institution: 'Oregon State University', degree: 'B.S.', field: 'Statistics', year: '2020', achievements: ['Dean’s list, 4 terms.'] }],
};

const LIN: ParsedResume = {
  name: '林知远',
  email: 'lin.zhiyuan@example.com',
  phone: '138 0000 0000',
  address: '上海',
  summary: '计算机科学与技术专业本科在读，有两段数据分析实习经历，熟悉 SQL 与 Python。',
  skills: { technical: ['Python', 'SQL'], frameworks: ['pandas', 'PyTorch'], tools: ['MySQL', 'Git'] },
  experience: [
    {
      role: '数据分析实习生',
      company: '星河科技',
      duration: '2025.06 - 2025.09',
      location: '上海',
      employmentType: 'internship',
      achievements: ['· 负责用户增长周报的数据提取与分析，覆盖 12 个业务团队。', '· 使用 SQL 与 Python 完成留存分析，并向产品团队汇报结论。'],
    },
    {
      role: '产品运营实习生',
      company: '云帆网络',
      duration: '2024.07 - 2024.09',
      location: '杭州',
      achievements: ['• 整理 300 份用户反馈，输出 3 份改进建议。'],
    },
  ],
  projects: [{ name: '校园二手交易小程序', role: '后端开发', date: '2024.03 - 2024.06', description: '负责订单与消息模块的接口开发。' }],
  education: [{ institution: '华东理工大学', degree: '本科', field: '计算机科学与技术', year: '2023.09 - 2027.06', achievements: ['GPA 3.7/4.0'] }],
  awards: [{ name: '校级一等奖学金', date: '2024' }],
};

/** Every piece of user text in a structured resume, for "nothing was lost" checks. */
function texts(md: string): string[] {
  const s = parseResumeMarkdown(md);
  return [
    s.contact.fullName,
    s.contact.email,
    s.contact.phone,
    s.summary,
    ...s.experiences.flatMap((e) => [e.title, e.company, e.location, e.startDate, e.endDate, ...e.bullets]),
    ...s.education.flatMap((e) => [e.school, e.degree, e.startDate, e.endDate, ...e.bullets]),
    ...s.skills,
    ...(s.skillGroups ?? []).map((g) => g.label),
    ...s.extraSections.flatMap((x) => [x.heading, x.markdown]),
  ].filter(Boolean);
}

describe('uploaded resume markdown → editor (English)', () => {
  const md = parsedResumeToMarkdown(MAYA);
  const s = parseResumeMarkdown(md);

  it('reads the role line into the right fields', () => {
    expect(s.experiences).toHaveLength(2);
    expect(s.experiences[0]).toMatchObject({
      title: 'Data Analyst',
      company: 'Northwind Freight',
      location: 'Portland, OR',
      startDate: 'June 2022',
      endDate: 'Present',
    });
    expect(s.experiences[0]!.bullets).toEqual([
      'Built a weekly on-time delivery dashboard in Tableau used by 12 dispatch managers.',
      'Automated a monthly cost report in Python (pandas), saving about 6 hours a month.',
    ]);
    expect(s.experiences[1]).toMatchObject({ title: 'Junior Analyst', company: 'Harbor Lane Grocers', location: 'Salem, OR', startDate: 'July 2020', endDate: 'May 2022' });
  });

  it('reads the education line into school, year and degree', () => {
    expect(s.education).toHaveLength(1);
    expect(s.education[0]).toMatchObject({ school: 'Oregon State University', degree: 'B.S., Statistics', startDate: '2020', endDate: '' });
    expect(s.education[0]!.bullets).toEqual(['Dean’s list, 4 terms.']);
  });

  it('keeps skill labels as groups and shows clean chips', () => {
    expect(s.skillGroups?.map((g) => g.label)).toEqual(['Technical', 'Frameworks', 'Tools', 'Languages', 'Soft skills']);
    expect(s.skills).toEqual(['SQL', 'PostgreSQL', 'Python (pandas, numpy)', 'Tableau', 'Excel', 'A/B testing', 'pandas', 'Zendesk', 'Jira', 'Stakeholder communication']);
    for (const chip of s.skills) expect(chip).not.toMatch(/\*|:$/);
  });

  it('one save is a fixed point and loses nothing', () => {
    const once = serializeResumeMarkdown(s);
    const twice = serializeResumeMarkdown(parseResumeMarkdown(once));
    expect(twice).toBe(once);
    expect(texts(once).sort()).toEqual(texts(md).sort());
    expect(once).not.toMatch(/\*\*\s*—|\d{4}\*\*|^\*\* /m);
    expect(once).toContain('### Northwind Freight · Data Analyst · June 2022 – Present');
    expect(once).toContain('### B.S., Statistics · Oregon State University · 2020');
    expect(once).toContain('**Tools:** Zendesk · Jira');
    // The projects section is not structured by the editor: it is kept verbatim.
    expect(once).toContain('**Route planner** · Author · 2021');
  });

  it('a chip removed or added in the editor edits the labelled lines, nothing else', () => {
    const edited = { ...s, skills: [...s.skills.filter((x) => x !== 'Jira'), 'dbt'] };
    const out = serializeResumeMarkdown(edited);
    expect(out).toContain('**Tools:** Zendesk\n');
    expect(out).toContain('**Soft skills:** Stakeholder communication\ndbt');
    expect(parseResumeMarkdown(out).skills).toContain('dbt');
    expect(parseResumeMarkdown(out).skills).not.toContain('Jira');
  });
});

describe('uploaded resume markdown → editor (Chinese)', () => {
  const md = parsedResumeToMarkdown(LIN);
  const s = parseResumeMarkdown(md);

  it('writes section titles and skill labels in the resume language', () => {
    expect(resumeDocLanguage(LIN)).toBe('zh');
    expect(resumeDocLanguage(MAYA)).toBe('en');
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    // Both roles are internships (…实习生), so the section is 实习经历.
    expect(headings).toEqual(['## 个人总结', '## 专业技能', '## 实习经历', '## 项目经历', '## 教育背景', '## 获奖情况']);
    expect(md).toContain('**框架：** pandas · PyTorch');
    expect(md).not.toMatch(/## (Summary|Skills|Experience|Projects|Education|Awards)/);
  });

  it('a resume with a full-time role gets 工作经历', () => {
    const mixed = { ...LIN, experience: [{ role: '数据分析师', company: '星河科技', duration: '2027.07 - 至今', achievements: ['负责增长分析。'] }, ...LIN.experience] };
    const out = parsedResumeToMarkdown(mixed);
    expect(out).toContain('## 工作经历');
    expect(out).not.toContain('## 实习经历');
    expect(parseResumeMarkdown(out).experiences[0]).toMatchObject({ title: '数据分析师', company: '星河科技', startDate: '2027.07', endDate: '至今' });
  });

  it('drops the bullet glyphs kept from the source file', () => {
    expect(md).not.toMatch(/^- [·•]/m);
    expect(s.experiences[0]!.bullets[0]).toBe('负责用户增长周报的数据提取与分析，覆盖 12 个业务团队。');
  });

  it('reads role, company, dates, place, school and degree', () => {
    expect(s.experiences[0]).toMatchObject({ title: '数据分析实习生', company: '星河科技', location: '上海', startDate: '2025.06', endDate: '2025.09' });
    expect(s.education[0]).toMatchObject({ school: '华东理工大学', degree: '本科, 计算机科学与技术', startDate: '2023.09', endDate: '2027.06' });
    expect(s.skillGroups?.map((g) => g.label)).toEqual(['技术', '框架', '工具']);
    expect(s.skills).toEqual(['Python', 'SQL', 'pandas', 'PyTorch', 'MySQL', 'Git']);
    expect(s.headings).toMatchObject({ summary: '个人总结', skills: '专业技能', education: '教育背景' });
  });

  it('one save is a fixed point, keeps the titles and loses nothing', () => {
    const once = serializeResumeMarkdown(s);
    expect(serializeResumeMarkdown(parseResumeMarkdown(once))).toBe(once);
    expect(texts(once).sort()).toEqual(texts(md).sort());
    expect(once).not.toMatch(/\*\*\s*[—-]|\d\*\*|^\*\* /m);
    expect(once).toContain('**框架：** pandas · PyTorch');
    expect(once.split('\n').filter((l) => l.startsWith('## '))).toEqual(md.split('\n').filter((l) => l.startsWith('## ')));
  });

  it('Resume check sees the roles of an upload (no false "no internship")', () => {
    const r = parseResume(md);
    const exp = r.sections.find((x) => x.key === 'experience')!;
    expect(exp.internship).toBe(true);
    expect(exp.entries.join(' ')).toContain('数据分析实习生');
  });

  it('the export reads the same headings and role lines', () => {
    const blocks = exportBlocks(md);
    expect(blocks.filter((b) => b.kind === 'h2').map((b) => b.text)).toContain('教育背景');
    expect(blocks.some((b) => b.kind === 'h3' && b.text.includes('星河科技'))).toBe(true);
    expect(blocks.some((b) => /^[·•]/.test(b.text))).toBe(false);
  });
});

describe('resumes an earlier build already rewrote', () => {
  // Saved by the editor before the fix (QA: .verify/ra-resume-letters/dl/base-Maya Lindqvist.md).
  const mangled = [
    '# Maya Lindqvist',
    '*maya.lindqvist@example.com · (555) 010-0142 · Portland, OR*',
    '',
    '## Experience',
    '',
    '### June 2022 – Present · Data Analyst — Northwind Freight · Portland, OR',
    '- Built a weekly on-time delivery dashboard in Tableau used by 12 dispatch managers.',
    '',
    '## Education',
    '',
    '### Oregon State University · 2020** — B.S., Statistics',
    '',
    '## Skills',
    '',
    'SQL · PostgreSQL · **Frameworks:** pandas · **Tools:** PostgreSQL · **Other:** A/B testing',
    '',
  ].join('\n');

  it('are read back into the right fields', () => {
    const s = parseResumeMarkdown(mangled);
    expect(s.experiences[0]).toMatchObject({ title: 'Data Analyst', company: 'Northwind Freight', location: 'Portland, OR', startDate: 'June 2022', endDate: 'Present' });
    expect(s.education[0]).toMatchObject({ school: 'Oregon State University', degree: 'B.S., Statistics', startDate: '2020' });
    expect(s.skills).toEqual(['SQL', 'PostgreSQL', 'pandas', 'A/B testing']);
    expect(s.skillGroups?.map((g) => g.label)).toEqual(['', 'Frameworks', 'Tools', 'Other']);
    const once = serializeResumeMarkdown(s);
    expect(once).not.toMatch(/\d{4}\*\*/);
    expect(serializeResumeMarkdown(parseResumeMarkdown(once))).toBe(once);
  });
});

describe('the editor’s own entry format is never taken for a mangled upload', () => {
  const one = (head: string) => {
    const md = ['# A B', '', '## Experience', '', head, '- Did the work.', ''].join('\n');
    return { md, e: parseResumeMarkdown(md).experiences[0]! };
  };

  it.each([
    ['### Current Health · Nurse · 2020 – 2022', { company: 'Current Health', title: 'Nurse', startDate: '2020', endDate: '2022', location: '' }],
    ['### Expo 2020 Dubai · Operations Lead · 2019 – 2021', { company: 'Expo 2020 Dubai', title: 'Operations Lead', startDate: '2019', endDate: '2021', location: '' }],
    ['### Now · Editor · 2021 – Present', { company: 'Now', title: 'Editor', startDate: '2021', endDate: 'Present', location: '' }],
    ['### 2020 · Engineer · 2019 – 2021', { company: '2020', title: 'Engineer', startDate: '2019', endDate: '2021', location: '' }],
    ['### Studio 2024 · Designer', { company: 'Studio 2024', title: 'Designer', startDate: '', endDate: '' }],
  ])('%s', (head, want) => {
    const { md, e } = one(head);
    expect(e).toMatchObject(want);
    // A company with a year or "Current" in its name survives a save unchanged.
    expect(serializeResumeMarkdown(parseResumeMarkdown(md))).toContain(head);
  });

  it.each([
    // Pasted: the bold part is the whole title, the company comes next.
    ['**Senior Engineer – Payments** · Stripe · 2021 – Present', { title: 'Senior Engineer – Payments', company: 'Stripe', startDate: '2021', endDate: 'Present', location: '' }],
    ['**Nurse** · Current Health · 2020 – 2022', { title: 'Nurse', company: 'Current Health', startDate: '2020', endDate: '2022', location: '' }],
    ['**Operations Lead** · Expo 2020 Dubai · 2019 – 2021 · Dubai', { title: 'Operations Lead', company: 'Expo 2020 Dubai', startDate: '2019', endDate: '2021', location: 'Dubai' }],
    // Upload: role and company in the bold part, then the dates and the place.
    ['**Support Team Lead — Acme** · 2021 – Present · Austin, TX', { title: 'Support Team Lead', company: 'Acme', startDate: '2021', endDate: 'Present', location: 'Austin, TX' }],
    ['**Nurse — Current Health** · Jan 2020 – Mar 2022', { title: 'Nurse', company: 'Current Health', startDate: 'Jan 2020', endDate: 'Mar 2022', location: '' }],
    ['**Support Team Lead — Acme** · Austin, TX', { title: 'Support Team Lead', company: 'Acme', startDate: '', location: 'Austin, TX' }],
    ['**数据分析师 — 星河科技** · 2021年3月 至今 · 上海', { title: '数据分析师', company: '星河科技', startDate: '2021年3月', endDate: '至今', location: '上海' }],
  ])('%s', (head, want) => {
    const { md, e } = one(head);
    expect(e).toMatchObject(want);
    const once = serializeResumeMarkdown(parseResumeMarkdown(md));
    expect(serializeResumeMarkdown(parseResumeMarkdown(once))).toBe(once);
  });

  it('still heals a head an earlier build wrote with the dates first', () => {
    expect(one('### 2021 – Present · Support Team Lead — Acme · Austin, TX').e).toMatchObject({ title: 'Support Team Lead', company: 'Acme', startDate: '2021', endDate: 'Present', location: 'Austin, TX' });
    expect(one('### 2021 – Present · Support Team Lead · Austin, TX').e).toMatchObject({ title: 'Support Team Lead', company: '', startDate: '2021', endDate: 'Present', location: 'Austin, TX' });
    expect(one('### 2025.06 - 2025.09 · 数据分析实习生 — 星河科技 · 上海').e).toMatchObject({ title: '数据分析实习生', company: '星河科技', startDate: '2025.06', endDate: '2025.09', location: '上海' });
  });
});
