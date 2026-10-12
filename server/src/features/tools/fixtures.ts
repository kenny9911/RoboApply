// server/src/features/tools/fixtures.ts — fictional resumes and files for the WP-57 tests.
// No vitest imports; compiles with the server.

/** A weak resume: weak openers, no numbers, no summary, no skills section. */
export const WEAK_RESUME_MD = [
  '# Sam Rivera',
  'sam@example.test',
  '',
  '## Experience',
  '',
  '### Shop Co · Assistant · 2021 – 2023',
  '- Responsible for helping customers with orders and returns at the front desk of the store every day',
  '- Responsible for stock',
  '- Worked on the website',
  '',
  '## Education',
  '',
  '### BA History · State University · 2017 – 2021',
].join('\n');

export const PRC_ID = '11010519491231002X';

/** A GoApply-style resume that carries a PRC ID number (not stored under CN_STORAGE_MODE=redact). */
export const CN_RESUME_MD = [
  '# 李明',
  `邮箱 li@example.test · 身份证号：${PRC_ID}`,
  '',
  '## 教育背景',
  '',
  '### 某大学 · 计算机科学 本科 · 2021 – 2025',
  '',
  '## 实习经历',
  '',
  '### 某科技公司 · 后端实习生 · 2024.07 – 2024.09',
  '- 负责接口开发',
  '',
  '## 专业技能',
  '',
  'Java · MySQL',
].join('\n');

export const POSTING = {
  title: 'Backend Engineer',
  text: [
    'We are hiring a Backend Engineer to build payment services.',
    'Requirements: 3+ years of experience with Python, PostgreSQL and Kubernetes.',
    "A bachelor's degree in computer science or similar. Experience with Kafka is a plus.",
  ].join('\n'),
};

/**
 * A plain-text resume as a visitor's file reads (a .txt, or the text layer of a
 * PDF): the title and employer on one line, the dates on the next. Fictional.
 */
export const DESIGNER_RESUME_TEXT = [
  'Marisol Okonkwo-Tanaka',
  'Portland, OR, USA · marisol@example.test · +1 503 555 0142',
  '',
  'SUMMARY',
  'Product designer with 9 years of experience designing B2B SaaS web and mobile products.',
  '',
  'PROFESSIONAL EXPERIENCE',
  'Senior Product Designer — Brightlane Logistics (fictional), Portland, OR',
  'March 2022 – Present',
  '- Led the redesign of the shipment tracking dashboard used by 1,200 dispatchers.',
  '- Built and maintained a 140-component design system in Figma.',
  '',
  'Product Designer — Fernwood Health (fictional), Seattle, WA',
  'June 2019 – February 2022',
  '- Designed the patient scheduling flow for iOS and Android.',
  '',
  'UX Designer — Studio Kestrel (fictional agency), Seattle, WA',
  'August 2017 – May 2019',
  '- Delivered responsive websites and web apps for 12 clients.',
  '',
  'EDUCATION',
  'B.A. Interaction Design — Cascadia State University (fictional), 2017',
  '',
  'SKILLS',
  'Figma, Design systems, User research, Usability testing, Prototyping',
].join('\n');

/** The same resume as the structured parse renders it (lib/candidateResumeIngest.ts `parsedResumeToMarkdown`). */
export const DESIGNER_RESUME_INGEST_MD = [
  '# Marisol Okonkwo-Tanaka',
  '',
  'marisol@example.test · +1 503 555 0142 · Portland, OR, USA',
  '',
  '## Summary',
  '',
  'Product designer with 9 years of experience designing B2B SaaS web and mobile products.',
  '',
  '## Skills',
  '',
  'Figma · Design systems · User research · Usability testing · Prototyping',
  '',
  '## Experience',
  '',
  '**Senior Product Designer — Brightlane Logistics (fictional)** · March 2022 – Present · Portland, OR',
  '- Led the redesign of the shipment tracking dashboard used by 1,200 dispatchers.',
  '- Built and maintained a 140-component design system in Figma.',
  '',
  '**Product Designer — Fernwood Health (fictional)** · June 2019 – February 2022 · Seattle, WA',
  '- Designed the patient scheduling flow for iOS and Android.',
  '',
  '**UX Designer — Studio Kestrel (fictional agency)** · August 2017 – May 2019 · Seattle, WA',
  '- Delivered responsive websites and web apps for 12 clients.',
  '',
  '## Education',
  '',
  '**Cascadia State University (fictional) · 2017** — B.A., Interaction Design',
].join('\n');

export const DESIGNER_POSTING = {
  title: 'Senior Product Designer',
  text: [
    'Senior Product Designer — Northwind Freight (fictional)',
    'We are looking for a Senior Product Designer to own the design of our carrier and dispatcher tools.',
    'Requirements:',
    '- 5+ years of product design experience on B2B SaaS products',
    '- Expert in Figma and design systems',
    '- Experience running user research and usability testing',
    "- Bachelor's degree in design or related field",
  ].join('\n'),
};

/** Minimal bytes that pass the first-bytes check for each accepted type. */
export const FILES = {
  pdf: () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('fake body for tests')]),
  docx: () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip body')]),
  doc: () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('ole body')]),
  txt: (text = WEAK_RESUME_MD) => Buffer.from(text, 'utf8'),
  png: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
