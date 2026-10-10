// components/features/resume/layout.ts — the resume layout model shared by
// the editor's Layout panel, the live paper preview and the export dialog
// (WP-36b; PRODUCT_PLAN.md F-RES-13).
//
// The server renders the same layout (server/src/roboapply/v2/lib/resumeExport.ts);
// the values here mirror its defaults so the preview matches the file.
// Pure functions, no React.

import type { ResumeLayout, ResumePage, ResumeTemplate } from '../../../lib/api/resumes';

/** Templates in picker order; Standard is recommended. */
export const TEMPLATES: readonly ResumeTemplate[] = ['standard', 'compact', 'centered', 'structured', 'two_column'];
export const RECOMMENDED_TEMPLATE: ResumeTemplate = 'standard';
/** Company software may read a sidebar out of order: the picker warns. */
export const WARN_TEMPLATES: readonly ResumeTemplate[] = ['two_column'];

export const DATE_FORMATS = ['as_written', 'MM/YYYY', 'Mon YYYY', 'YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const FONTS = ['sans', 'serif'] as const;
export type ResumeFont = (typeof FONTS)[number];

/** Spacing presets → the layout's point values (resumeExport `spacing`). */
export const SPACING_PRESETS = {
  tight: { section: 5, entry: 2, line: 0.5, marginX: 40, marginY: 38 },
  normal: { section: 10, entry: 5, line: 2, marginX: 54, marginY: 54 },
  roomy: { section: 15, entry: 8, line: 3.5, marginX: 64, marginY: 62 },
} as const;
export type SpacingPreset = keyof typeof SPACING_PRESETS;
export const SPACING_KEYS = Object.keys(SPACING_PRESETS) as SpacingPreset[];

/** Accent swatches (document ink, not app chrome). The first is the default. */
export const ACCENTS = ['#1a1a1a', '#1f3a68', '#0f5e5a', '#5b2a86', '#8a2b2b'] as const;
export const DEFAULT_ACCENT = ACCENTS[0];

export interface ResolvedLayout {
  template: ResumeTemplate;
  page: ResumePage;
  font: ResumeFont;
  accent: string;
  headerAlign: 'left' | 'center';
  dateFormat: DateFormat;
  spacing: SpacingPreset;
}

export function normalizeTemplate(value: unknown): ResumeTemplate {
  if (typeof value !== 'string') return 'standard';
  const v = value.trim().toLowerCase().replace(/[-\s]/g, '_');
  if ((TEMPLATES as readonly string[]).includes(v)) return v as ResumeTemplate;
  if (v === 'split' || v === 'sidebar') return 'two_column';
  return 'standard';
}

/** The preset closest to stored spacing values (exact match on `section`, else normal). */
export function spacingPresetOf(spacing: ResumeLayout['spacing'] | undefined | null): SpacingPreset {
  const section = spacing?.section;
  for (const key of SPACING_KEYS) if (SPACING_PRESETS[key].section === section) return key;
  return 'normal';
}

/** Fill a stored layout with defaults (page from the server's Letter/A4 default). */
export function resolveLayout(layout: ResumeLayout | null | undefined, defaultPage: ResumePage = 'letter'): ResolvedLayout {
  const l = layout ?? {};
  const template = normalizeTemplate(l.template);
  return {
    template,
    page: l.page === 'a4' || l.page === 'letter' ? l.page : defaultPage,
    font: l.font === 'serif' ? 'serif' : 'sans',
    accent: typeof l.accent === 'string' && /^#[0-9a-f]{6}$/i.test(l.accent) ? l.accent : DEFAULT_ACCENT,
    headerAlign: l.headerAlign ?? (template === 'centered' ? 'center' : 'left'),
    dateFormat: (DATE_FORMATS as readonly string[]).includes(l.dateFormat ?? '') ? (l.dateFormat as DateFormat) : 'as_written',
    spacing: spacingPresetOf(l.spacing),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_RE = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';

function fmt(month: number, year: string, format: DateFormat): string {
  if (format === 'YYYY') return year;
  if (format === 'MM/YYYY') return `${String(month).padStart(2, '0')}/${year}`;
  return `${MONTHS[month - 1]} ${year}`;
}

/** Same rules as the server's `formatDatesIn`: month-year dates only; words and bare years untouched. */
export function formatDatesIn(text: string, format: DateFormat): string {
  if (format === 'as_written' || !text) return text;
  return text
    .replace(new RegExp(`\\b${MONTH_RE}\\s+((?:19|20)\\d{2})\\b`, 'g'), (m, mon: string, y: string) => {
      const idx = MONTHS.findIndex((x) => mon.toLowerCase().startsWith(x.toLowerCase()));
      return idx >= 0 ? fmt(idx + 1, y, format) : m;
    })
    .replace(/\b(0?[1-9]|1[0-2])\/((?:19|20)\d{2})\b/g, (_m, mm: string, y: string) => fmt(Number(mm), y, format))
    .replace(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])\b/g, (_m, y: string, mm: string) => fmt(Number(mm), y, format));
}

const SIDEBAR_RE = /(skill|education|language|certif|award|interest|tool|技能|教育|语言|語言|证书|證照|证照|获奖|獲獎|荣誉|榮譽|兴趣|興趣)/i;

/** Sections the two-column template puts in the sidebar (matches the server). */
export function isSidebarSection(title: string): boolean {
  return SIDEBAR_RE.test(title);
}

/** Height ÷ width of the page, for the preview sheet. */
export function pageAspect(page: ResumePage): number {
  return page === 'a4' ? 297 / 210 : 11 / 8.5;
}

/** The layout patch for one picker change (what PATCH /:id/layout receives). */
export function layoutPatch(change: Partial<ResolvedLayout>): Partial<ResumeLayout> {
  const patch: Partial<ResumeLayout> = {};
  if (change.template) patch.template = change.template;
  if (change.page) patch.page = change.page;
  if (change.font) patch.font = change.font;
  if (change.accent) patch.accent = change.accent;
  if (change.headerAlign) patch.headerAlign = change.headerAlign;
  if (change.dateFormat) patch.dateFormat = change.dateFormat;
  if (change.spacing) patch.spacing = { ...SPACING_PRESETS[change.spacing] };
  return patch;
}
