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

/** A GoApply-style resume that carries a PRC ID number (CN-0 must not store it). */
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

/** Minimal bytes that pass the first-bytes check for each accepted type. */
export const FILES = {
  pdf: () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('fake body for tests')]),
  docx: () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('zip body')]),
  doc: () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('ole body')]),
  txt: (text = WEAK_RESUME_MD) => Buffer.from(text, 'utf8'),
  png: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
