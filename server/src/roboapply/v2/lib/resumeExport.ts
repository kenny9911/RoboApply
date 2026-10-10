// server/src/roboapply/v2/lib/resumeExport.ts
//
// Server-side export of a resume variant's markdown to a real PDF or DOCX
// (WP-36b; PRODUCT_PLAN.md F-RES-13/F-RES-15, CN-E-07, TW-04).
//
// Pure entry points (no DB, no LLM; deterministic and unit-tested in
// components/features/resume/server/resumeExport.test.ts). The cover-letter exporter (WP-37) imports them
// read-only:
//   parseResumeMarkdown(md)          → ResumeBlock[]
//   resolveLayout(raw, defaults)     → ResumeRenderLayout (sanitized `RAResumeVariant.layout`)
//   renderResumePdf(md, options?)    → Promise<Buffer> (application/pdf)
//   renderResumeDocx(md, options?)   → Promise<Buffer> (Word .docx)
//   defaultPageFor({ market, country, locale }) → 'letter' | 'a4'
//   formatDatesIn(text, format)      → dates rewritten to the chosen format
//   fontChainFor / splitFontRuns     → the per-run font fallback
//
// Templates: standard (recommended) · compact · centered · structured ·
// two_column (a sidebar; company software may read it out of order, so the
// editor shows a warning). Fonts are limited to what we can ship, chosen per
// run of text by glyph coverage: the PDF standard faces Helvetica / Times for
// WinAnsi text, then the bundled OFL faces — Noto Sans (Latin Extended, Greek,
// Cyrillic), Noto Sans SC, Han Sans TC, Noto Sans KR and Noto Sans JP — in a
// locale-dependent order (server/assets/fonts/README.md).
//
// AI labels (WP-13): when the caller passes `aiLabel`, the PDF Info dictionary,
// the XMP packet and the DOCX custom properties carry the machine-readable
// marks, and `footerLine` (GoApply with CN_AI_EXPORT_EXPLICIT_LABEL=on) prints
// the visible line on every page. No user text goes into the label.
//
// Sensitive fields (photo, 籍贯, 政治面貌, …) are never sent to a model; when a
// template places them it does so here, after any model call (TASK_PLAN.md
// §2.2). Today's templates place only what the resume markdown already holds.

import PDFDocument from 'pdfkit';
import { AlignmentType, Document, Footer, HeadingLevel, Packer, Paragraph, TextRun, BorderStyle } from 'docx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImplicitAiLabel } from '../../../features/compliance/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/ is server/src/roboapply/v2/lib → up 4 to server/, then assets/fonts.
export const FONT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'assets', 'fonts');

// ── Fonts ─────────────────────────────────────────────────────────────────
//
// The PDF picks a font per run of text, by glyph coverage (never one font for
// the whole document): the PDF standard face (Helvetica/Times) for everything
// WinAnsi encodes, then the bundled faces in a fallback chain — Noto Sans
// (Latin Extended, Greek, Cyrillic, Vietnamese), then the Han/Hangul/kana faces
// in an order that depends on the export locale. See server/assets/fonts/README.md.

export type FaceKey = 'latin' | 'sc' | 'tc' | 'kr' | 'jp';
/** Kept for callers that name the primary Han face. */
export type CjkFamily = 'NotoSansSC' | 'NotoSansTC' | 'HanSansTC' | 'NotoSansKR' | 'NotoSansJP';

export interface FontFaces {
  key: FaceKey;
  family: string;
  regular: string;
  bold: string;
}

/**
 * Candidate files per face, first present wins. Traditional Chinese prefers
 * Noto Sans TC files when ops drops them in; the shipped TC face is a subset of
 * Source Han Sans TW (the same design as Noto Sans CJK TC), renamed "Han Sans
 * TC" because the OFL reserves the name "Source" for modified versions.
 */
const FACE_CANDIDATES: Record<FaceKey, ReadonlyArray<readonly [family: string, regular: string, bold: string]>> = {
  latin: [['NotoSans', 'NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']],
  sc: [['NotoSansSC', 'NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf']],
  tc: [
    ['NotoSansTC', 'NotoSansTC-Regular.ttf', 'NotoSansTC-Bold.ttf'],
    ['HanSansTC', 'HanSansTC-Regular.otf', 'HanSansTC-Bold.otf'],
  ],
  kr: [['NotoSansKR', 'NotoSansKR-Regular.ttf', 'NotoSansKR-Bold.ttf']],
  jp: [['NotoSansJP', 'NotoSansJP-Regular.ttf', 'NotoSansJP-Bold.ttf']],
};

/** The bundled files for one face, or null when they are not shipped. */
export function bundledFace(key: FaceKey): FontFaces | null {
  for (const [family, r, b] of FACE_CANDIDATES[key]) {
    const regular = path.join(FONT_DIR, r);
    const bold = path.join(FONT_DIR, b);
    if (fs.existsSync(regular) && fs.existsSync(bold)) return { key, family, regular, bold };
  }
  return null;
}

const HAN_ORDER: Record<'zh' | 'zhHant' | 'ja' | 'ko', FaceKey[]> = {
  zh: ['sc', 'tc', 'jp', 'kr'],
  zhHant: ['tc', 'sc', 'jp', 'kr'],
  ja: ['jp', 'tc', 'sc', 'kr'],
  ko: ['kr', 'tc', 'sc', 'jp'],
};

const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff]/;
const HANGUL_RE = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/;

/**
 * Order of the Han/Hangul/kana faces for an export: by locale when given,
 * otherwise by the script the text uses (kana → Japanese, Hangul → Korean).
 */
export function hanOrderFor(locale?: string | null, text = ''): FaceKey[] {
  const l = (locale ?? '').toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(l)) return HAN_ORDER.zhHant;
  if (l.startsWith('zh')) return HAN_ORDER.zh;
  if (l.startsWith('ja')) return HAN_ORDER.ja;
  if (l.startsWith('ko')) return HAN_ORDER.ko;
  if (KANA_RE.test(text)) return HAN_ORDER.ja;
  if (HANGUL_RE.test(text)) return HAN_ORDER.ko;
  return HAN_ORDER.zh;
}

/** The bundled fallback chain (present faces only): Latin first, then Han order. */
export function fontChainFor(locale?: string | null, text = ''): FontFaces[] {
  return (['latin', ...hanOrderFor(locale, text)] as FaceKey[]).map(bundledFace).filter((f): f is FontFaces => f !== null);
}

/**
 * The primary Han face for an export locale (zh-TW → TC, ja → JP, ko → KR,
 * otherwise SC), falling back along the chain when a face is missing.
 */
export function unicodeFontFor(locale?: string | null): FontFaces | null {
  for (const key of hanOrderFor(locale ?? 'zh')) {
    const face = bundledFace(key);
    if (face) return face;
  }
  return null;
}

/** True when the bundled Noto Sans SC faces are present (CJK glyphs, not boxes). */
export function hasCjkFonts(): boolean {
  return bundledFace('sc') !== null;
}

/** Characters beyond Latin-1 that the PDF standard fonts still encode (WinAnsi). */
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** True when the PDF standard fonts (WinAnsi) can draw this character. */
export function isWinAnsi(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20) return ch === '\n' || ch === '\t';
  if (cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WINANSI_EXTRA.has(ch);
}

/** True when the text needs a Unicode font (CJK, Cyrillic, Latin Extended, …). */
export function needsUnicodeFont(text: string): boolean {
  for (const ch of text) if (!isWinAnsi(ch)) return true;
  return false;
}

export function containsCjk(text: string): boolean {
  return /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/.test(text);
}

const coverageCache = new Map<string, ReadonlySet<number>>();

/**
 * Code points a TrueType/OpenType file maps to a real glyph (cmap formats 4
 * and 12; glyph 0 is .notdef and does not count). Cached per file.
 */
export function fontCoverage(file: string): ReadonlySet<number> {
  const cached = coverageCache.get(file);
  if (cached) return cached;
  const out = new Set<number>();
  try {
    const b = fs.readFileSync(file);
    const numTables = b.readUInt16BE(4);
    let cmap = -1;
    for (let i = 0; i < numTables; i += 1) {
      const r = 12 + i * 16;
      if (b.toString('latin1', r, r + 4) === 'cmap') cmap = b.readUInt32BE(r + 8);
    }
    if (cmap >= 0) {
      const n = b.readUInt16BE(cmap + 2);
      const subtables: Array<{ pid: number; eid: number; off: number; format: number }> = [];
      for (let i = 0; i < n; i += 1) {
        const r = cmap + 4 + i * 8;
        const off = cmap + b.readUInt32BE(r + 4);
        subtables.push({ pid: b.readUInt16BE(r), eid: b.readUInt16BE(r + 2), off, format: b.readUInt16BE(off) });
      }
      const unicode = (t: (typeof subtables)[number]) => t.pid === 0 || (t.pid === 3 && (t.eid === 1 || t.eid === 10));
      const pick = subtables.find((t) => unicode(t) && t.format === 12) ?? subtables.find((t) => unicode(t) && t.format === 4);
      if (pick?.format === 12) {
        const groups = b.readUInt32BE(pick.off + 12);
        for (let g = 0; g < groups; g += 1) {
          const r = pick.off + 16 + g * 12;
          const start = b.readUInt32BE(r);
          const end = b.readUInt32BE(r + 4);
          const gid = b.readUInt32BE(r + 8);
          for (let c = start; c <= end; c += 1) if (gid + (c - start) !== 0) out.add(c);
        }
      } else if (pick?.format === 4) {
        const o = pick.off;
        const segX2 = b.readUInt16BE(o + 6);
        const ends = o + 14;
        const starts = ends + segX2 + 2;
        const deltas = starts + segX2;
        const ranges = deltas + segX2;
        for (let s = 0; s < segX2; s += 2) {
          const end = b.readUInt16BE(ends + s);
          const start = b.readUInt16BE(starts + s);
          const delta = b.readUInt16BE(deltas + s);
          const rangeOff = b.readUInt16BE(ranges + s);
          for (let c = start; c <= end && c !== 0xffff; c += 1) {
            let gid: number;
            if (rangeOff === 0) gid = (c + delta) & 0xffff;
            else {
              const at = ranges + s + rangeOff + (c - start) * 2;
              gid = at + 1 < b.length ? b.readUInt16BE(at) : 0;
              if (gid !== 0) gid = (gid + delta) & 0xffff;
            }
            if (gid !== 0) out.add(c);
          }
        }
      }
    }
  } catch {
    // An unreadable font covers nothing; the chain moves on.
  }
  coverageCache.set(file, out);
  return out;
}

/** True when the face's regular and bold files both draw this code point. */
export function faceHasGlyph(face: FontFaces, cp: number): boolean {
  return fontCoverage(face.regular).has(cp) && fontCoverage(face.bold).has(cp);
}

export interface FontRun {
  text: string;
  /** `std` = the PDF standard face (Helvetica/Times); otherwise a bundled face. */
  face: FaceKey | 'std';
}

const ATTACHING_RE = /[\p{M}\u200c\u200d\ufe00-\ufe0f]/u;

/**
 * Split text into runs by font: each character goes to the first font in
 * [standard face, …chain] that has a glyph for it. Spaces and combining marks
 * stay in the current run when its font draws them. A character no font has
 * goes to an embedded face, where it shows as a box rather than vanishing.
 */
export function splitFontRuns(text: string, chain: readonly FontFaces[]): FontRun[] {
  const runs: FontRun[] = [];
  const has = (face: FontRun['face'], ch: string, cp: number) =>
    face === 'std' ? isWinAnsi(ch) : faceHasGlyph(chain.find((f) => f.key === face)!, cp);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const last = runs[runs.length - 1];
    let face: FontRun['face'] | undefined;
    if (last && (/\s/.test(ch) || ATTACHING_RE.test(ch)) && has(last.face, ch, cp)) face = last.face;
    if (!face && isWinAnsi(ch)) face = 'std';
    if (!face) face = chain.find((f) => faceHasGlyph(f, cp))?.key;
    // Nothing has it: keep it visible as a box in an embedded face (the
    // standard faces cannot even encode it).
    if (!face) face = (last && last.face !== 'std' ? last.face : chain[0]?.key) ?? 'std';
    if (last && last.face === face) last.text += ch;
    else runs.push({ text: ch, face });
  }
  return runs;
}

// ── Layout ────────────────────────────────────────────────────────────────

export const RESUME_TEMPLATE_KEYS = ['standard', 'compact', 'centered', 'structured', 'two_column'] as const;
export type ResumeTemplateKey = (typeof RESUME_TEMPLATE_KEYS)[number];
export const DATE_FORMATS = ['as_written', 'MM/YYYY', 'Mon YYYY', 'YYYY'] as const;
export type DateFormatKey = (typeof DATE_FORMATS)[number];
export const RESUME_FONTS = ['sans', 'serif'] as const;
export type ResumeFontKey = (typeof RESUME_FONTS)[number];
export type PageSize = 'letter' | 'a4';

export interface ResumeRenderLayout {
  template: ResumeTemplateKey;
  page: PageSize;
  font: ResumeFontKey;
  /** `#rrggbb` for section titles and rules. */
  accent: string;
  headerAlign: 'left' | 'center';
  dateFormat: DateFormatKey;
  hideDivider: boolean;
  /** Point sizes. */
  sizes: { name: number; section: number; sub: number; body: number };
  /**
   * Points: `section` before a section title, `entry` before a role/school
   * line, `line` extra leading between lines, `marginX`/`marginY` page margins.
   */
  spacing: { section: number; entry: number; line: number; marginX: number; marginY: number };
}

const TEMPLATE_DEFAULTS: Record<ResumeTemplateKey, Pick<ResumeRenderLayout, 'sizes' | 'spacing' | 'headerAlign'>> = {
  standard: { sizes: { name: 22, section: 12.5, sub: 10.8, body: 9.8 }, spacing: { section: 10, entry: 5, line: 2, marginX: 54, marginY: 54 }, headerAlign: 'left' },
  compact: { sizes: { name: 18, section: 11, sub: 10, body: 9.2 }, spacing: { section: 6, entry: 3, line: 1, marginX: 40, marginY: 38 }, headerAlign: 'left' },
  centered: { sizes: { name: 22, section: 12, sub: 10.8, body: 9.8 }, spacing: { section: 10, entry: 5, line: 2, marginX: 54, marginY: 54 }, headerAlign: 'center' },
  structured: { sizes: { name: 21, section: 11.5, sub: 10.6, body: 9.8 }, spacing: { section: 11, entry: 5, line: 2, marginX: 50, marginY: 50 }, headerAlign: 'left' },
  two_column: { sizes: { name: 21, section: 11.5, sub: 10.4, body: 9.4 }, spacing: { section: 9, entry: 4, line: 1.5, marginX: 42, marginY: 44 }, headerAlign: 'left' },
};

export const DEFAULT_ACCENT = '#1a1a1a';

const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

/** Map legacy/editor template names onto the five export templates. */
export function normalizeTemplate(value: unknown): ResumeTemplateKey {
  if (typeof value !== 'string') return 'standard';
  const v = value.trim().toLowerCase().replace(/[-\s]/g, '_');
  if ((RESUME_TEMPLATE_KEYS as readonly string[]).includes(v)) return v as ResumeTemplateKey;
  if (v === 'split' || v === 'sidebar') return 'two_column';
  return 'standard';
}

/**
 * Sanitize a stored `RAResumeVariant.layout` into a complete render layout.
 * Unknown values fall back to the template defaults; nothing throws.
 */
export function resolveLayout(raw: unknown, defaults: { page?: PageSize } = {}): ResumeRenderLayout {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const template = normalizeTemplate(l.template ?? l.templateKey);
  const t = TEMPLATE_DEFAULTS[template];
  const sizes = (l.sizes && typeof l.sizes === 'object' ? l.sizes : {}) as Record<string, unknown>;
  const spacing = (l.spacing && typeof l.spacing === 'object' ? l.spacing : {}) as Record<string, unknown>;
  const accent = typeof l.accent === 'string' && /^#[0-9a-f]{6}$/i.test(l.accent) ? l.accent : DEFAULT_ACCENT;
  return {
    template,
    page: l.page === 'a4' || l.page === 'letter' ? l.page : defaults.page ?? 'letter',
    font: l.font === 'serif' ? 'serif' : 'sans',
    accent,
    headerAlign: l.headerAlign === 'center' || l.headerAlign === 'left' ? l.headerAlign : t.headerAlign,
    dateFormat: (DATE_FORMATS as readonly string[]).includes(l.dateFormat) ? l.dateFormat : 'as_written',
    hideDivider: l.hideDivider === true,
    sizes: {
      name: clamp(sizes.name, 14, 30, t.sizes.name),
      section: clamp(sizes.section, 9, 16, t.sizes.section),
      sub: clamp(sizes.sub, 8.5, 14, t.sizes.sub),
      body: clamp(sizes.body, 8, 12, t.sizes.body),
    },
    spacing: {
      section: clamp(spacing.section, 2, 24, t.spacing.section),
      entry: clamp(spacing.entry, 0, 14, t.spacing.entry),
      line: clamp(spacing.line, 0, 6, t.spacing.line),
      marginX: clamp(spacing.marginX, 28, 80, t.spacing.marginX),
      marginY: clamp(spacing.marginY, 28, 80, t.spacing.marginY),
    },
  };
}

/** Countries that use US Letter paper; everyone else uses A4. */
const LETTER_COUNTRIES = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'PR', 'SV', 'NI', 'HN', 'BO']);

/**
 * Default paper size: GoApply (mainland China) → A4; otherwise by the
 * visitor's country when known; otherwise US Letter for `en`/`en-US` and A4
 * for every other locale (Taiwan included).
 */
export function defaultPageFor(input: { market?: string | null; country?: string | null; locale?: string | null }): PageSize {
  if (input.market === 'cn') return 'a4';
  const country = (input.country ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) return LETTER_COUNTRIES.has(country) ? 'letter' : 'a4';
  const locale = (input.locale ?? '').trim();
  const region = locale.split(/[-_]/)[1]?.toUpperCase();
  if (region && /^[A-Z]{2}$/.test(region)) return LETTER_COUNTRIES.has(region) ? 'letter' : 'a4';
  return !locale || /^en$/i.test(locale) ? 'letter' : 'a4';
}

// ── Dates ─────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_RE = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';

function fmtDate(month: number, year: string, format: DateFormatKey): string {
  if (format === 'YYYY') return year;
  if (format === 'MM/YYYY') return `${String(month).padStart(2, '0')}/${year}`;
  return `${MONTHS[month - 1]} ${year}`;
}

/**
 * Rewrite month-year dates (`03/2021`, `Mar 2021`, `March 2021`, `2021-03`)
 * into one format. `as_written` leaves the text alone. Words like "Present"
 * and bare years are never touched.
 */
export function formatDatesIn(text: string, format: DateFormatKey): string {
  if (format === 'as_written' || !text) return text;
  return text
    .replace(new RegExp(`\\b${MONTH_RE}\\s+((?:19|20)\\d{2})\\b`, 'g'), (_m, mon: string, y: string) => {
      const idx = MONTHS.findIndex((x) => mon.toLowerCase().startsWith(x.toLowerCase()));
      return idx >= 0 ? fmtDate(idx + 1, y, format) : _m;
    })
    .replace(/\b(0?[1-9]|1[0-2])\/((?:19|20)\d{2})\b/g, (_m, mm: string, y: string) => fmtDate(Number(mm), y, format))
    .replace(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])\b/g, (_m, y: string, mm: string) => fmtDate(Number(mm), y, format));
}

// ── Markdown → blocks ─────────────────────────────────────────────────────

export type ResumeBlockKind = 'h1' | 'h2' | 'h3' | 'bullet' | 'para';

export interface ResumeBlock {
  kind: ResumeBlockKind;
  text: string;
}

/** Strip inline markdown emphasis/link syntax to plain text (keeps link text + url). */
function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .trim();
}

/**
 * Parse resume markdown into an ordered, render-agnostic block list. Headings
 * (#/##/###), bullets (-, *, •) and paragraphs; rules and blank lines are
 * dropped. Pure and deterministic.
 */
export function parseResumeMarkdown(markdown: string): ResumeBlock[] {
  const blocks: ResumeBlock[] = [];
  for (const raw of (markdown ?? '').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue;
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^#\s+(.*)$/))) blocks.push({ kind: 'h1', text: stripInline(m[1]!) });
    else if ((m = t.match(/^##\s+(.*)$/))) blocks.push({ kind: 'h2', text: stripInline(m[1]!) });
    else if ((m = t.match(/^#{3,}\s+(.*)$/))) blocks.push({ kind: 'h3', text: stripInline(m[1]!) });
    else if ((m = t.match(/^[-*•]\s+(.*)$/))) blocks.push({ kind: 'bullet', text: stripInline(m[1]!) });
    else if ((m = t.match(/^>\s*(.*)$/))) blocks.push({ kind: 'para', text: stripInline(m[1]!) });
    else {
      // A role line written as **Company** — Title reads like a sub-heading.
      const isRoleLine = /^\*\*[^*]+\*\*/.test(t) && t.length <= 160;
      blocks.push({ kind: isRoleLine ? 'h3' : 'para', text: stripInline(t) });
    }
  }
  return blocks.filter((b) => b.text.length > 0);
}

interface ResumeSection {
  title: string;
  blocks: ResumeBlock[];
}

interface ResumeDoc {
  name: string | null;
  header: ResumeBlock[];
  sections: ResumeSection[];
}

function structure(blocks: ResumeBlock[], layout: ResumeRenderLayout): ResumeDoc {
  const doc: ResumeDoc = { name: null, header: [], sections: [] };
  let current: ResumeSection | null = null;
  for (const b0 of blocks) {
    const b = b0.kind === 'h1' ? b0 : { ...b0, text: formatDatesIn(b0.text, layout.dateFormat) };
    if (b.kind === 'h1' && doc.name === null && !current) {
      doc.name = b.text;
      continue;
    }
    if (b.kind === 'h2' || (b.kind === 'h1' && doc.name !== null)) {
      current = { title: b.text, blocks: [] };
      doc.sections.push(current);
      continue;
    }
    if (!current) doc.header.push(b);
    else current.blocks.push(b);
  }
  return doc;
}

/** Sections that go to the sidebar of the two-column template. */
const SIDEBAR_RE = /(skill|education|language|certif|award|interest|tool|技能|教育|语言|語言|证书|證照|证照|获奖|獲獎|荣誉|榮譽|兴趣|興趣)/i;

export function isSidebarSection(title: string): boolean {
  return SIDEBAR_RE.test(title);
}

// ── Render options ────────────────────────────────────────────────────────

export interface RenderOptions {
  /** `RAResumeVariant.layout` (any shape; sanitized here). */
  layout?: unknown;
  /** Paper size when the layout does not set one (see defaultPageFor). */
  defaultPage?: PageSize;
  /** Export locale: picks the CJK face (zh-TW → TC when bundled). */
  locale?: string | null;
  /** Machine-readable AI marks (complianceService.implicitLabelMetadata). */
  aiLabel?: ImplicitAiLabel | null;
  /** Visible AI line printed at the foot of every page (GoApply, when enabled). */
  footerLine?: string | null;
  /** Document title (PDF Info / DOCX core property). */
  title?: string | null;
}

function pdfToBuffer(doc: InstanceType<typeof PDFDocument>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const PAGE_POINTS: Record<PageSize, [number, number]> = { letter: [612, 792], a4: [595.28, 841.89] };

/** Every glyph the document will draw (for the font decision). */
function allText(doc: ResumeDoc, footerLine?: string | null): string {
  return [doc.name ?? '', ...doc.header.map((b) => b.text), ...doc.sections.flatMap((s) => [s.title, ...s.blocks.map((b) => b.text)]), footerLine ?? ''].join('\n');
}

/**
 * Render resume markdown to a PDF (Buffer). Only the resume content is drawn,
 * never editor chrome.
 */
export async function renderResumePdf(markdown: string, options: RenderOptions = {}): Promise<Buffer> {
  const layout = resolveLayout(options.layout, { page: options.defaultPage });
  const parsed = structure(parseResumeMarkdown(markdown), layout);
  const text = allText(parsed, options.footerLine);
  const chain = needsUnicodeFont(text) ? fontChainFor(options.locale, text) : [];

  const info: Record<string, string> = { Title: (options.title || parsed.name || 'Resume').slice(0, 200) };
  if (options.aiLabel) Object.assign(info, options.aiLabel.pdfInfo);
  const [pw, ph] = PAGE_POINTS[layout.page];
  const { marginX, marginY } = layout.spacing;
  const footerReserve = options.footerLine ? 18 : 0;
  const doc = new PDFDocument({
    size: [pw, ph],
    // The bottom margin keeps the footer line clear, including on pages
    // pdfkit adds by itself when a paragraph runs over.
    margins: { top: marginY, bottom: marginY + footerReserve, left: marginX, right: marginX },
    bufferPages: true,
    pdfVersion: '1.7',
    info: info as any,
  });
  if (options.aiLabel?.xmp) doc.appendXML(options.aiLabel.xmp);

  // Fonts are registered lazily by pdfkit: only faces a run uses get embedded.
  for (const face of chain) {
    doc.registerFont(`${face.key}-reg`, face.regular);
    doc.registerFont(`${face.key}-bold`, face.bold);
  }
  const stdReg = layout.font === 'serif' ? 'Times-Roman' : 'Helvetica';
  const stdBold = layout.font === 'serif' ? 'Times-Bold' : 'Helvetica-Bold';
  type Weight = 'reg' | 'bold';
  const fontName = (face: FontRun['face'], weight: Weight) =>
    face === 'std' ? (weight === 'bold' ? stdBold : stdReg) : `${face}-${weight}`;
  const runsOf = (t: string): FontRun[] => (chain.length ? splitFontRuns(t, chain) : [{ text: t, face: 'std' }]);

  interface TextOpts {
    width?: number;
    align?: 'left' | 'center' | 'right' | 'justify';
    lineGap?: number;
    characterSpacing?: number;
    lineBreak?: boolean;
    continued?: boolean;
    baseline?: number;
  }
  /** Draw text run by run, each in the font that has its glyphs. */
  const draw = (t: string, weight: Weight, size: number, x: number, y: number, opts: TextOpts) => {
    const runs = runsOf(t);
    if (runs.length <= 1) {
      doc.font(fontName(runs[0]?.face ?? 'std', weight)).fontSize(size).text(runs[0]?.text ?? t, x, y, opts);
      return;
    }
    let o: TextOpts = opts;
    let startX = x;
    if (opts.align === 'center' || opts.align === 'right') {
      // pdfkit aligns each continued fragment on its own, so a mixed-font
      // line is placed by hand when it fits on one line.
      const total = runs.reduce(
        (w, r) => w + doc.font(fontName(r.face, weight)).fontSize(size).widthOfString(r.text, { characterSpacing: opts.characterSpacing }),
        0,
      );
      const width = opts.width ?? pw - x - marginX;
      if (total <= width) {
        startX = opts.align === 'center' ? x + (width - total) / 2 : x + width - total;
        o = { ...opts, align: 'left', width: total + 2 };
      } else {
        o = { ...opts, align: 'left' };
      }
    }
    // Every run sits on the first run's baseline (pdfkit otherwise offsets
    // each fragment by its own font's ascender, so mixed fonts would bob).
    // A numeric baseline is in points; the ascender is in 1/1000 em.
    const ascender = (doc.font(fontName(runs[0]!.face, weight)) as unknown as { _font: { ascender: number } })._font.ascender;
    runs.forEach((r, i) => {
      const last = i === runs.length - 1;
      doc.font(fontName(r.face, weight)).fontSize(size);
      if (i === 0) doc.text(r.text, startX, y, { ...o, baseline: -(ascender / 1000) * size, continued: !last });
      else doc.text(r.text, { continued: !last });
    });
  };
  /** Approximate height of a block, measured in the font of its longest run. */
  const measure = (t: string, weight: Weight, size: number, width: number, opts: TextOpts = {}) => {
    const runs = runsOf(t);
    const main = runs.reduce((a, r) => (r.text.length > a.text.length ? r : a), runs[0] ?? { text: t, face: 'std' as const });
    return doc.font(fontName(main.face, weight)).fontSize(size).heightOfString(t, { ...opts, width });
  };

  const left = marginX;
  const contentWidth = pw - marginX * 2;
  const bottomLimit = ph - marginY - footerReserve;
  const pageContent = bottomLimit - marginY;
  const lineGap = layout.spacing.line;
  const ink = '#222222';
  const sub = '#333333';
  const centered = layout.headerAlign === 'center';
  const sectionAlign = layout.template === 'centered' ? 'center' : 'left';

  // Header (name + contact lines) across the full width.
  if (parsed.name) {
    doc.fillColor('#111111');
    draw(parsed.name, 'bold', layout.sizes.name, left, doc.y, { width: contentWidth, align: centered ? 'center' : 'left' });
    doc.moveDown(0.2);
  }
  for (const b of parsed.header) {
    doc.fillColor(sub);
    draw(b.text, 'reg', layout.sizes.body, left, doc.y, { width: contentWidth, align: centered ? 'center' : 'left', lineGap });
  }
  if (layout.template === 'structured' && !layout.hideDivider) {
    doc.moveTo(left, doc.y + 4).lineTo(left + contentWidth, doc.y + 4).strokeColor(layout.accent).lineWidth(1.2).stroke();
    doc.moveDown(0.4);
  }
  const headerBottom = doc.y + 4;

  /**
   * Draw one section into a column (doc.y advances). Before each block the
   * guard gets the block's measured height, so a block that fits on a page
   * never straddles the bottom margin.
   */
  const drawSection = (s: ResumeSection, x: number, width: number, guard: (reserve: number) => void) => {
    doc.y += layout.spacing.section;
    const title = layout.template === 'structured' ? s.title.toLocaleUpperCase() : s.title;
    const titleOpts: TextOpts = { width, align: sectionAlign, characterSpacing: layout.template === 'structured' ? 0.6 : 0 };
    const firstBody = s.blocks[0] ? measure(s.blocks[0].text, 'reg', layout.sizes.body, width, { lineGap }) : 0;
    // Keep the title with the first line of its first block.
    guard(measure(title, 'bold', layout.sizes.section, width, titleOpts) + 7 + Math.min(firstBody, layout.sizes.body * 1.6));
    doc.fillColor(layout.accent);
    draw(title, 'bold', layout.sizes.section, x, doc.y, titleOpts);
    if (!layout.hideDivider && layout.template !== 'structured') {
      doc.moveTo(x, doc.y + 2).lineTo(x + width, doc.y + 2).strokeColor(layout.accent === DEFAULT_ACCENT ? '#cccccc' : layout.accent).lineWidth(0.6).stroke();
    }
    doc.y += 5;
    for (const b of s.blocks) {
      if (b.kind === 'h3' || b.kind === 'h1' || b.kind === 'h2') {
        doc.y += layout.spacing.entry;
        guard(measure(b.text, 'bold', layout.sizes.sub, width, { lineGap }) + layout.sizes.body * 1.4);
        doc.fillColor(ink);
        draw(b.text, 'bold', layout.sizes.sub, x, doc.y, { width, lineGap });
        doc.y += 1;
      } else {
        const t = b.kind === 'bullet' ? `•  ${b.text}` : b.text;
        guard(measure(t, 'reg', layout.sizes.body, width, { lineGap }));
        doc.fillColor(sub);
        draw(t, 'reg', layout.sizes.body, x, doc.y, { width, lineGap });
        doc.y += b.kind === 'bullet' ? 1 : 2;
      }
    }
  };

  /** A guard that moves to `next()` when the block would cross the bottom margin. */
  const guardWith = (next: () => void) => (reserve: number) => {
    // A block taller than a page breaks across pages anyway; only move when
    // the move helps.
    const need = Math.min(reserve, pageContent);
    if (doc.y + need > bottomLimit && doc.y > marginY + 1) next();
  };

  if (layout.template === 'two_column') {
    const gutter = 18;
    const sideWidth = Math.round(contentWidth * 0.32);
    const mainX = left + sideWidth + gutter;
    const mainWidth = contentWidth - sideWidth - gutter;
    const side = parsed.sections.filter((s) => isSidebarSection(s.title));
    const main = parsed.sections.filter((s) => !isSidebarSection(s.title));

    // Main column first: it owns page breaks (pages are appended in order).
    doc.y = headerBottom;
    const mainGuard = guardWith(() => {
      doc.addPage();
      doc.y = marginY;
    });
    for (const s of main) drawSection(s, mainX, mainWidth, mainGuard);

    // Sidebar from the top of page 1, walking the pages the main column made
    // before adding one. pdfkit's own overflow break (a line that crosses the
    // bottom margin) would append a page at the end, so it is pointed at the
    // same walk while the sidebar draws.
    let pageIndex = doc.bufferedPageRange().start;
    const nextSidePage = () => {
      pageIndex += 1;
      const range = doc.bufferedPageRange();
      if (pageIndex < range.start + range.count) doc.switchToPage(pageIndex);
      else {
        doc.addPage();
        pageIndex = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
      }
      doc.y = marginY;
    };
    doc.switchToPage(pageIndex);
    doc.y = headerBottom;
    const self = doc as unknown as { continueOnNewPage: () => unknown };
    self.continueOnNewPage = () => {
      nextSidePage();
      return doc;
    };
    try {
      for (const s of side) drawSection(s, left, sideWidth, guardWith(nextSidePage));
    } finally {
      delete (self as { continueOnNewPage?: unknown }).continueOnNewPage;
    }
  } else {
    doc.y = headerBottom;
    const guard = guardWith(() => {
      doc.addPage();
      doc.y = marginY;
    });
    for (const s of parsed.sections) drawSection(s, left, contentWidth, guard);
  }

  if (!parsed.name && parsed.sections.length === 0 && parsed.header.length === 0) {
    doc.font(stdReg).fontSize(10).fillColor('#999999').text('(empty resume)', left, marginY);
  }

  if (options.footerLine) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      // Writing below the bottom margin must not trigger an automatic page.
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fillColor('#666666');
      draw(options.footerLine, 'reg', 7.5, left, ph - marginY + 4, { width: contentWidth, align: 'center', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
  }

  return pdfToBuffer(doc);
}

const HEX = (c: string) => c.replace('#', '').toUpperCase();

/**
 * Render resume markdown to a Word .docx (Buffer). Word supplies its own CJK
 * fonts, so nothing is embedded; the AI marks go into custom properties.
 */
export async function renderResumeDocx(markdown: string, options: RenderOptions = {}): Promise<Buffer> {
  const layout = resolveLayout(options.layout, { page: options.defaultPage });
  const parsed = structure(parseResumeMarkdown(markdown), layout);
  const centered = layout.headerAlign === 'center';
  const halfPt = (pt: number) => Math.round(pt * 2);
  const latinFont = layout.font === 'serif' ? 'Times New Roman' : 'Arial';
  const run = (text: string, opts: { bold?: boolean; size: number; color?: string; caps?: boolean }) =>
    new TextRun({ text, bold: opts.bold, size: halfPt(opts.size), color: opts.color, allCaps: opts.caps, font: latinFont });

  const children: Paragraph[] = [];
  if (parsed.name) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT, children: [run(parsed.name, { bold: true, size: layout.sizes.name, color: '111111' })] }));
  }
  for (const b of parsed.header) {
    children.push(new Paragraph({ alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT, children: [run(b.text, { size: layout.sizes.body, color: '333333' })] }));
  }
  // Word reflows a sidebar unpredictably; two_column exports as one column
  // with the sidebar sections last (the PDF keeps the sidebar).
  const sections =
    layout.template === 'two_column'
      ? [...parsed.sections.filter((s) => !isSidebarSection(s.title)), ...parsed.sections.filter((s) => isSidebarSection(s.title))]
      : parsed.sections;
  const twip = (pt: number) => Math.round(pt * 20);
  for (const s of sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: layout.template === 'centered' ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: twip(layout.spacing.section + 4), after: twip(4) },
        border: layout.hideDivider ? undefined : { bottom: { style: BorderStyle.SINGLE, size: 4, color: layout.accent === DEFAULT_ACCENT ? 'CCCCCC' : HEX(layout.accent), space: 1 } },
        children: [run(s.title, { bold: true, size: layout.sizes.section, color: HEX(layout.accent), caps: layout.template === 'structured' })],
      }),
    );
    for (const b of s.blocks) {
      if (b.kind === 'bullet') {
        children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: twip(layout.spacing.line) }, children: [run(b.text, { size: layout.sizes.body, color: '333333' })] }));
      } else if (b.kind === 'para') {
        children.push(new Paragraph({ spacing: { after: twip(layout.spacing.line + 2) }, children: [run(b.text, { size: layout.sizes.body, color: '333333' })] }));
      } else {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: twip(layout.spacing.entry + 2), after: twip(2) }, children: [run(b.text, { bold: true, size: layout.sizes.sub, color: '222222' })] }));
      }
    }
  }
  if (children.length === 0) children.push(new Paragraph({ text: '(empty resume)' }));

  const [pw, ph] = PAGE_POINTS[layout.page];
  const footers = options.footerLine
    ? { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: options.footerLine, size: 15, color: '666666' })] })] }) }
    : undefined;
  const doc = new Document({
    title: (options.title || parsed.name || 'Resume').slice(0, 200),
    customProperties: options.aiLabel
      ? Object.entries(options.aiLabel.docxCustomProperties).map(([name, value]) => ({ name, value }))
      : undefined,
    sections: [
      {
        properties: {
          page: {
            size: { width: twip(pw), height: twip(ph) },
            margin: { top: twip(layout.spacing.marginY), bottom: twip(layout.spacing.marginY), left: twip(layout.spacing.marginX), right: twip(layout.spacing.marginX) },
          },
        },
        footers,
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// ── File names ────────────────────────────────────────────────────────────

export const FILE_NAME_STYLE_KEYS = ['name_company_role', 'name_role', 'company_role_name', 'name_date'] as const;
export type FileNameStyleKey = (typeof FILE_NAME_STYLE_KEYS)[number];

/** Strip characters that break file systems or headers; collapse whitespace. */
export function cleanFilePart(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Build a download file name (without extension) from a preset. Missing parts
 * are skipped, never invented; with nothing usable it falls back to `fallback`.
 */
export function buildExportFileName(
  style: FileNameStyleKey | null | undefined,
  parts: { name?: string | null; company?: string | null; role?: string | null; date?: Date; fallback: string },
): string {
  const name = cleanFilePart(parts.name);
  const company = cleanFilePart(parts.company);
  const role = cleanFilePart(parts.role);
  const date = (parts.date ?? new Date()).toISOString().slice(0, 10);
  let pieces: string[];
  switch (style) {
    case 'name_role':
      pieces = [name, role];
      break;
    case 'company_role_name':
      pieces = [company, role, name];
      break;
    case 'name_date':
      pieces = [name, date];
      break;
    case 'name_company_role':
      pieces = [name, company, role];
      break;
    default:
      pieces = [];
  }
  const joined = pieces.filter(Boolean).join(' - ');
  return joined || cleanFilePart(parts.fallback) || 'Resume';
}
