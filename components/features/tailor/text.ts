// components/features/tailor/text.ts — how resume text is shown in the tailor
// result (change rows and Verify-details cards). Pure.

/**
 * A resume line without its inline markdown marks: "**框架：** pandas" reads
 * "框架： pandas". The marks are markup the export never prints; shown raw in
 * a card they read as noise. Words, numbers and punctuation are untouched.
 */
export function plainInline(text: string): string {
  return (text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[\s(（])\*(?!\s)([^*\n]+?)\*(?=$|[\s).,;:，。；：）])/g, '$1$2')
    .replace(/(^|[\s(（])_(?!\s)([^_\n]+?)_(?=$|[\s).,;:，。；：）])/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export type TailorSectionName = 'summary' | 'experience' | 'skills' | 'projects' | 'education';

/** The default English section titles an uploaded or built resume carries. */
const DEFAULT_TITLES: Record<string, TailorSectionName> = {
  summary: 'summary',
  'professional summary': 'summary',
  profile: 'summary',
  experience: 'experience',
  'work experience': 'experience',
  'professional experience': 'experience',
  skills: 'skills',
  'technical skills': 'skills',
  projects: 'projects',
  education: 'education',
};

/**
 * The section name for a change row. A default English title ("Summary",
 * "Experience") is shown in the interface language — with the interface in
 * Chinese the rows read 已新增 · 个人总结, not 已新增 · Summary. A title the
 * resume writes itself (实习经历, "Selected work") stays exactly as written.
 */
export function sectionLabel(heading: string, translate: (key: TailorSectionName) => string): string {
  const key = DEFAULT_TITLES[(heading ?? '').trim().toLowerCase()];
  return key ? translate(key) : heading;
}
