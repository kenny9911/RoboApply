// lib/resumeTheme.ts
//
// Resume design tokens — single source of truth for everything the Designer
// tab can change. Lives outside any component file so the preview, the page,
// and the panel all agree on shape + defaults.

export type TemplateKey = 'ats-clean' | 'modern' | 'compact' | 'two-column';

export type FontKey =
  | 'geist'
  | 'inter'
  | 'poppins'
  | 'roboto'
  | 'source-sans'
  | 'merriweather'
  | 'lora';

export type DateFormat = 'MM/YYYY' | 'Mon YYYY' | 'YYYY';

export type Alignment = 'left' | 'center' | 'right';
export type SkillsLayout = 'comma' | 'comma-list' | 'columns';
export type PaperSize = 'letter' | 'a4';

export interface ResumeTheme {
  templateKey: TemplateKey;
  accent: string;
  font: FontKey;
  /** Percent — applies to body paragraphs. */
  lineHeight: number;
  /** Percent — applies to bullet lists. */
  listLineHeight: number;
  dateFormat: DateFormat;
  headerAlignment: Alignment;
  dateAlignment: 'left' | 'right';
  locationAlignment: 'left' | 'right';
  skillsLayout: SkillsLayout;
  paperSize: PaperSize;
  /** Inches — left + right margins. */
  marginsLR: number;
  /** Inches — top + bottom margins. */
  marginsTB: number;
}

export const DEFAULT_THEME: ResumeTheme = {
  templateKey: 'ats-clean',
  accent: '#0f766e',
  font: 'inter',
  lineHeight: 120,
  listLineHeight: 120,
  dateFormat: 'MM/YYYY',
  headerAlignment: 'left',
  dateAlignment: 'right',
  locationAlignment: 'right',
  skillsLayout: 'comma',
  paperSize: 'letter',
  marginsLR: 0.6,
  marginsTB: 0.6,
};

/** The résumé Designer picker. Four faces, was eight.
 *
 *  Geist, Poppins and Roboto are RETIRED: their woff2 no longer ships (see
 *  app/layout.tsx). `FontKey` deliberately still accepts them so résumés with
 *  one of those persisted keeps parsing — `fontFamilyFor` maps them onto
 *  Inter. Do not narrow the union; the value lives in the database. */
export const FONT_OPTIONS: { key: FontKey; label: string; cssVar: string }[] = [
  { key: 'inter', label: 'Inter', cssVar: 'var(--font-inter)' },
  { key: 'source-sans', label: 'Source Sans 3', cssVar: 'var(--font-source-sans)' },
  { key: 'lora', label: 'Lora', cssVar: 'var(--font-lora)' },
  { key: 'merriweather', label: 'Merriweather', cssVar: 'var(--font-merriweather)' },
];

/** Retired keys → the face they now render in. */
const RETIRED_FONTS: Record<string, string> = {
  geist: 'var(--font-inter)',
  poppins: 'var(--font-inter)',
  roboto: 'var(--font-inter)',
};

/** Teal-style palette + the RoboApply accent at the front. */
export const ACCENT_SWATCHES: { color: string; label: string }[] = [
  { color: '#0f0f10', label: 'Ink' },
  { color: '#6b7280', label: 'Slate' },
  { color: '#0f766e', label: 'Teal' },
  { color: '#b45309', label: 'Gold' },
  { color: '#ef4444', label: 'Red' },
  { color: '#7f1d1d', label: 'Maroon' },
  { color: '#3b82f6', label: 'Sky' },
  { color: '#1d4ed8', label: 'Indigo' },
  { color: '#f97316', label: 'Orange' },
];

export function fontFamilyFor(font: FontKey): string {
  const found = FONT_OPTIONS.find((f) => f.key === font);
  const cssVar = found?.cssVar ?? RETIRED_FONTS[font] ?? 'var(--font-inter)';
  // --font-han: Source Han Sans, defined only under html[lang='zh'/'zh-TW']
  // (globals.css) — CJK résumé text renders 思源黑體 there; everywhere else
  // the var() fallback collapses to system-ui and nothing extra downloads.
  return `${cssVar}, var(--font-han, system-ui), system-ui, sans-serif`;
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Parse a freeform date string ("04/2022", "Present", "Apr 2022") and reformat
 *  it according to the theme. Unknown inputs pass through unchanged. */
export function formatDateString(raw: string, fmt: DateFormat): string {
  const s = raw.trim();
  if (!s) return '';
  if (/^present$/i.test(s) || /^current$/i.test(s)) return 'Present';
  // MM/YYYY
  let m = s.match(/^(\d{1,2})\s*\/\s*(\d{4})$/);
  if (m) {
    const mm = Number(m[1]);
    const yyyy = m[2];
    if (mm >= 1 && mm <= 12) {
      if (fmt === 'MM/YYYY') return `${String(mm).padStart(2, '0')}/${yyyy}`;
      if (fmt === 'Mon YYYY') return `${MONTHS_SHORT[mm - 1]} ${yyyy}`;
      return yyyy;
    }
  }
  // YYYY only
  m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  return s;
}
