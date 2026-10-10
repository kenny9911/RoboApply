// server/src/roboapply/v2/lib/resumeExport.ts
//
// Server-side export of a resume variant's markdown to a real PDF or DOCX
// (WP-36b; PRODUCT_PLAN.md F-RES-13/F-RES-15, CN-E-07, TW-04).
//
// Pure entry points (no DB, no LLM; deterministic and unit-tested in
// resumeExport.test.ts next to this file). The cover-letter exporter (WP-37) imports them
// read-only:
//   parseResumeMarkdown(md)          → ResumeBlock[]
//   resolveLayout(raw, defaults)     → ResumeRenderLayout (sanitized `RAResumeVariant.layout`)
//   renderResumePdf(md, options?)    → Promise<Buffer> (application/pdf)
//   renderResumeDocx(md, options?)   → Promise<Buffer> (Word .docx)
//   defaultPageFor({ market, country, locale }) → 'letter' | 'a4'
//   formatDatesIn(text, format)      → dates rewritten to the chosen format
//   fontChainFor / splitFontRuns     → the per-run font fallback
//   createRunDrawer(doc, { chain })  → the same fallback as a pdfkit drawer; the
//                                      cover-letter and receipt PDFs draw with it
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
// Sensitive fields (photo, 籍贯, 政治面貌, …) are never sent to a model; the
// renderer places them here, after any model call (TASK_PLAN.md §2.2; WP-65):
// `layout.personal` (籍贯 / 政治面貌 the user entered) prints as one header
// line, and a photo the user keeps on their device prints top-right when the
// download request carries it (`options.photo`, or `withExportPhoto()` around
// an export). The photo is never stored on the server.
//
// WP-65 also renders the saved `justify`, `bullet`, `eduOrder` and
// `skillsLayout`, the `campus` template (A4 new-grad layout), the zh/en section
// titles (`headingLanguage`; the user's own text stays as written), and counts
// pages for fit-to-page (`renderResumePdfWithMeta`, `countResumePages`).

import PDFDocument from 'pdfkit';
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
  TextWrappingType,
  BorderStyle,
  VerticalPositionAlign,
  VerticalPositionRelativeFrom,
} from 'docx';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImplicitAiLabel } from '../../../features/compliance/index.js';
import type { BuilderDocLanguage, BuilderSection, HeadingLanguage, ResumePersonal } from '../../../features/resume/contract.js';
import { FIELD_LABELS, SECTION_HEADINGS } from '../../../features/resume/builder/sections.js';

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

// ── Per-run drawing (shared by the resume, cover-letter and receipt PDFs) ───

/** The fallback chain a text needs: none when the PDF standard faces draw all of it. */
export function fontChainForText(locale: string | null | undefined, text: string): FontFaces[] {
  return needsUnicodeFont(text) ? fontChainFor(locale, text) : [];
}

export type FontWeight = 'reg' | 'bold';

export interface RunTextOptions {
  width?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  lineGap?: number;
  characterSpacing?: number;
  lineBreak?: boolean;
  continued?: boolean;
  baseline?: number;
}

export interface RunDrawer {
  /** The text split by font (one `std` run when no chain is needed). */
  runsOf(text: string): FontRun[];
  /** The registered pdfkit font name for a face and weight. */
  fontName(face: FontRun['face'], weight: FontWeight): string;
  /** Draw text run by run, each in the font that has its glyphs. */
  draw(text: string, weight: FontWeight, size: number, x: number, y: number, opts?: RunTextOptions): void;
  /** Approximate height of a block, measured in the font of its longest run. */
  measure(text: string, weight: FontWeight, size: number, width: number, opts?: RunTextOptions): number;
}

/**
 * The per-run font fallback over one pdfkit document. Registers the chain's
 * faces (pdfkit embeds only the ones a run uses) and draws each run of text in
 * the first font that has its glyphs: the PDF standard face for WinAnsi text,
 * then the bundled faces in chain order (Latin Extended, then Han/Hangul/kana
 * by export locale). One implementation for every PDF we make, so a Korean
 * letter gets the KR face and a Traditional-only character on a receipt gets
 * the TC face instead of a box.
 */
export function createRunDrawer(
  doc: InstanceType<typeof PDFDocument>,
  config: {
    chain: readonly FontFaces[];
    /** PDF standard faces for WinAnsi text (default Helvetica). */
    stdRegular?: string;
    stdBold?: string;
    /** Width available from `x` when a call gives none (centre/right alignment of mixed-font lines). */
    widthFrom: (x: number) => number;
  },
): RunDrawer {
  const { chain } = config;
  const stdReg = config.stdRegular ?? 'Helvetica';
  const stdBold = config.stdBold ?? 'Helvetica-Bold';
  // Fonts are registered lazily by pdfkit: only faces a run uses get embedded.
  for (const face of chain) {
    doc.registerFont(`${face.key}-reg`, face.regular);
    doc.registerFont(`${face.key}-bold`, face.bold);
  }
  const fontName = (face: FontRun['face'], weight: FontWeight) => (face === 'std' ? (weight === 'bold' ? stdBold : stdReg) : `${face}-${weight}`);
  const runsOf = (t: string): FontRun[] => (chain.length ? splitFontRuns(t, chain) : [{ text: t, face: 'std' }]);

  const draw = (t: string, weight: FontWeight, size: number, x: number, y: number, opts: RunTextOptions = {}) => {
    const runs = runsOf(t);
    if (runs.length <= 1) {
      doc.font(fontName(runs[0]?.face ?? 'std', weight)).fontSize(size).text(runs[0]?.text ?? t, x, y, opts);
      return;
    }
    // pdfkit cannot justify a line made of several fonts' fragments.
    let o: RunTextOptions = opts.align === 'justify' ? { ...opts, align: 'left' } : opts;
    let startX = x;
    if (opts.align === 'center' || opts.align === 'right') {
      // pdfkit aligns each continued fragment on its own, so a mixed-font
      // line is placed by hand when it fits on one line.
      const total = runs.reduce(
        (w, r) => w + doc.font(fontName(r.face, weight)).fontSize(size).widthOfString(r.text, { characterSpacing: opts.characterSpacing }),
        0,
      );
      const width = opts.width ?? config.widthFrom(x);
      if (total <= width) {
        startX = opts.align === 'center' ? x + (width - total) / 2 : x + width - total;
        o = { ...opts, align: 'left', width: total + 2 };
      } else {
        o = { ...opts, align: 'left' };
      }
    }
    // Every run sits on ONE baseline: that of the tallest font in the line
    // (pdfkit otherwise offsets each fragment by its own font's ascender, so
    // mixed fonts would bob). A numeric baseline is in points; the ascender
    // is in 1/1000 em.
    //
    // The line is also as tall as its tallest font. pdfkit advances by the
    // LAST fragment's line height only, so a line that starts in a CJK face
    // and ends in Helvetica ("校园二手交易平台 · 2025.03 – 2025.06") advanced
    // by Helvetica's shorter line while its glyphs sat on the CJK baseline:
    // the next line was drawn over it (QA: a project title under its first
    // bullet). The difference is added after the last fragment.
    const faces = [...new Set(runs.map((r) => fontName(r.face, weight)))];
    const metrics = faces.map((name) => {
      const f = doc.font(name).fontSize(size);
      return { name, ascender: (f as unknown as { _font: { ascender: number } })._font.ascender, lineHeight: f.currentLineHeight(true) };
    });
    const ascender = Math.max(...metrics.map((m) => m.ascender));
    const tallest = Math.max(...metrics.map((m) => m.lineHeight));
    runs.forEach((r, i) => {
      const last = i === runs.length - 1;
      doc.font(fontName(r.face, weight)).fontSize(size);
      if (i === 0) doc.text(r.text, startX, y, { ...o, baseline: -(ascender / 1000) * size, continued: !last });
      else doc.text(r.text, { continued: !last });
    });
    if (opts.continued) return;
    const lastLine = metrics.find((m) => m.name === fontName(runs[runs.length - 1]!.face, weight))!.lineHeight;
    if (tallest > lastLine) doc.y += tallest - lastLine;
  };

  /** Height of a block: the tallest of its fonts decides (a mixed line is as tall as its tallest font). */
  const measure = (t: string, weight: FontWeight, size: number, width: number, opts: RunTextOptions = {}) => {
    const faces = [...new Set(runsOf(t).map((r) => fontName(r.face, weight)))];
    if (faces.length === 0) faces.push(fontName('std', weight));
    return Math.max(...faces.map((name) => doc.font(name).fontSize(size).heightOfString(t, { ...opts, width })));
  };

  return { runsOf, fontName, draw, measure };
}

// ── Layout ────────────────────────────────────────────────────────────────

export const RESUME_TEMPLATE_KEYS = ['standard', 'compact', 'centered', 'structured', 'two_column', 'campus'] as const;
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
  // ── WP-65 ──
  /** Justify paragraphs and bullets. */
  justify: boolean;
  /** The bullet mark drawn before each bullet. */
  bullet: string;
  /** Education before / after experience; null = as written. */
  eduOrder: 'before_experience' | 'after_experience' | null;
  /** Skills as written, on one line, or in two columns (PDF). */
  skillsLayout: 'inline' | 'grouped' | 'columns';
  /** Section titles in this language; 'as_written' leaves them alone. */
  headingLanguage: HeadingLanguage;
  /** 籍贯 / 政治面貌 the user entered (printed in the header), or null. */
  personal: ResumePersonal | null;
  /** Print the photo the download request carries. */
  photo: boolean;
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
  campus: { sizes: { name: 20, section: 11.5, sub: 10.4, body: 9.6 }, spacing: { section: 8, entry: 4, line: 1.5, marginX: 46, marginY: 42 }, headerAlign: 'left' },
};

/** Named bullet styles → the mark drawn. */
const BULLET_MARKS: Record<string, string> = { solid: '•', hollow: '◦', dash: '–' };

/** The bullet mark for a stored `layout.bullet` (a style name or one character). */
export function bulletMarkOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '•';
  const v = value.trim();
  if (BULLET_MARKS[v]) return BULLET_MARKS[v]!;
  return [...v].length === 1 ? v : '•';
}

function personalOf(value: unknown): ResumePersonal | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const clean = (x: unknown) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, 40) : '');
  const nativePlace = clean(p.nativePlace);
  const politicalStatus = clean(p.politicalStatus);
  if (!nativePlace && !politicalStatus) return null;
  return { ...(nativePlace ? { nativePlace } : {}), ...(politicalStatus ? { politicalStatus } : {}) };
}

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
    justify: l.justify === true,
    bullet: bulletMarkOf(l.bullet),
    eduOrder: l.eduOrder === 'before_experience' || l.eduOrder === 'after_experience' ? l.eduOrder : null,
    skillsLayout: l.skillsLayout === 'inline' || l.skillsLayout === 'columns' ? l.skillsLayout : 'grouped',
    headingLanguage: l.headingLanguage === 'en' || l.headingLanguage === 'zh' || l.headingLanguage === 'zh-TW' ? l.headingLanguage : 'as_written',
    personal: personalOf(l.personal),
    photo: l.photo !== false,
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
      // A labelled skills line ("**Tools:** Zendesk · Jira") is body text.
      const isRoleLine = /^\*\*[^*]+\*\*/.test(t) && !/^\*\*[^*]*[:：]\s*\*\*/.test(t) && t.length <= 160;
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

// ── Section titles (zh/en bilingual export; WP-65) ───────────────────────

type HeadingKey = BuilderSection | 'skillsCertificates';

/** Most specific first: internship before experience, 技能证书 before skills. */
const HEADING_RULES: Array<[HeadingKey, RegExp]> = [
  ['intent', /求职意向|求職意向|求职条件|求職條件|job objective|career objective|^objective$/i],
  ['selfEvaluation', /自我评价|自我評價|个人评价|個人評價|about me|self[- ]?evaluation/i],
  ['autobiography', /自傳|自传|个人陈述|個人陳述|autobiograph/i],
  ['summary', /^(professional )?summary$|^profile$|个人总结|個人摘要|个人简介|個人簡介|個人總結/i],
  ['internship', /intern|实习|實習/i],
  ['campus', /campus|extracurricular|社团|社團|校园经历|校園經歷|学生工作|學生工作/i],
  ['experience', /^(work |professional )?experience$|employment|work history|工作经历|工作經歷|工作经验|工作經驗/i],
  ['projects', /project|项目经历|項目經歷|專案/i],
  ['education', /education|教育|学历|學歷/i],
  ['skillsCertificates', /技能证书|技能證書|skills (?:&|and) certificates|專長與證照/i],
  ['certificates', /certif|证书|證書|證照|资格|資格/i],
  ['skills', /skill|专业技能|專業技能|專長|技能/i],
  ['awards', /award|honou?r|获奖|獲獎|荣誉|榮譽/i],
];

/** The builder section a heading names, or null. */
export function headingKeyOf(title: string): HeadingKey | null {
  const t = title.trim();
  for (const [key, re] of HEADING_RULES) if (re.test(t)) return key;
  return null;
}

const SKILLS_CERTIFICATES: Record<BuilderDocLanguage, string> = { en: 'Skills & certificates', zh: '技能证书', 'zh-TW': '專長與證照' };

/** A section title in the chosen language; unknown titles stay as written. */
export function translateHeading(title: string, language: HeadingLanguage): string {
  if (language === 'as_written') return title;
  const key = headingKeyOf(title);
  if (!key) return title;
  if (key === 'skillsCertificates') return SKILLS_CERTIFICATES[language];
  return SECTION_HEADINGS[language][key] ?? title;
}

/**
 * The default English titles the upload step used to write for every resume,
 * whatever its language (it now writes them in the resume's language — see
 * `parsedResumeToMarkdown`). On a Chinese resume they were never the user's
 * words, so "as written" prints them in the resume's language instead.
 */
const UPLOAD_DEFAULT_TITLES: Record<string, Record<'zh' | 'zh-TW', string>> = {
  summary: { zh: '个人总结', 'zh-TW': '個人摘要' },
  skills: { zh: '专业技能', 'zh-TW': '專長' },
  experience: { zh: '工作经历', 'zh-TW': '工作經歷' },
  projects: { zh: '项目经历', 'zh-TW': '專案經歷' },
  education: { zh: '教育背景', 'zh-TW': '學歷' },
  certifications: { zh: '证书', 'zh-TW': '證照' },
  awards: { zh: '获奖情况', 'zh-TW': '獲獎紀錄' },
  languages: { zh: '语言能力', 'zh-TW': '語言能力' },
};
const INTERNSHIP_TITLE: Record<'zh' | 'zh-TW', string> = { zh: '实习经历', 'zh-TW': '實習經歷' };

/** 'zh' / 'zh-TW' when the body of the resume is written in Chinese, else 'en'. */
export function bodyLanguage(blocks: readonly ResumeBlock[]): BuilderDocLanguage {
  const text = blocks.filter((b) => b.kind !== 'h1' && b.kind !== 'h2').map((b) => b.text).join('\n');
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  if (letters === 0 || han < letters * 0.2 || /[\u3040-\u30ff\uac00-\ud7af]/.test(text)) return 'en';
  const traditional = (text.match(/[個學實經專證歷與為這國從來時們說對開關點數據業務責體發現應網絡資訊軟設計畫團隊優勢領導項驗語執環維護測試動態產銷運營]/g) ?? []).length;
  const simplified = (text.match(/[个学实经专证历与为这国从来时们说对开关点数据业务责体发现应网络资讯软设计划团队优势领导项验语执环维护测试动态产销运营]/g) ?? []).length;
  return traditional > simplified ? 'zh-TW' : 'zh';
}

/** A section title for the export: the chosen language, or as written (see UPLOAD_DEFAULT_TITLES). */
function exportTitle(section: ResumeSection, layout: ResumeRenderLayout, language: BuilderDocLanguage): string {
  if (layout.headingLanguage !== 'as_written') return translateHeading(section.title, layout.headingLanguage);
  if (language === 'en') return section.title;
  const key = section.title.trim().toLowerCase();
  const local = UPLOAD_DEFAULT_TITLES[key];
  if (!local) return section.title;
  if (key === 'experience') {
    const roles = section.blocks.filter((b) => b.kind === 'h3');
    if (roles.length > 0 && roles.every((b) => /实习|實習/.test(b.text))) return INTERNSHIP_TITLE[language];
  }
  return local[language];
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
  // Education before / after experience (F-RES-13 "Education order").
  if (layout.eduOrder) {
    const isEdu = (s: ResumeSection) => headingKeyOf(s.title) === 'education';
    // Work or internship experience, whichever comes first (new-grad resumes).
    const isExp = (s: ResumeSection) => {
      const key = headingKeyOf(s.title);
      return key === 'experience' || key === 'internship';
    };
    const edu = doc.sections.findIndex(isEdu);
    const exp = doc.sections.findIndex(isExp);
    if (edu >= 0 && exp >= 0) {
      const wantBefore = layout.eduOrder === 'before_experience';
      if ((wantBefore && edu > exp) || (!wantBefore && edu < exp)) {
        const [section] = doc.sections.splice(edu, 1);
        const at = doc.sections.findIndex(isExp);
        doc.sections.splice(wantBefore ? at : at + 1, 0, section!);
      }
    }
  }
  const language = layout.headingLanguage === 'as_written' ? bodyLanguage(blocks) : layout.headingLanguage;
  for (const s of doc.sections) s.title = exportTitle(s, layout, language);
  return doc;
}

/** True for a skills section (the `skillsLayout` applies to it). */
function isSkillsSection(title: string): boolean {
  const key = headingKeyOf(title);
  return key === 'skills';
}

/** The labels' language for the personal-details line. */
function personalLanguage(layout: ResumeRenderLayout, text: string, locale?: string | null): BuilderDocLanguage {
  if (layout.headingLanguage !== 'as_written') return layout.headingLanguage;
  if (!containsCjk(text)) return 'en';
  return /^zh-(tw|hk|mo|hant)/i.test(locale ?? '') || /[個學實經專證歷]/.test(text) ? 'zh-TW' : 'zh';
}

/** "籍贯：浙江杭州 ｜ 政治面貌：中共党员" (only the details the user entered). */
export function personalLine(personal: ResumePersonal | null, language: BuilderDocLanguage): string | null {
  if (!personal) return null;
  const L = FIELD_LABELS[language];
  const colon = language === 'en' ? ': ' : '：';
  const parts: string[] = [];
  if (personal.nativePlace) parts.push(`${L.nativePlace}${colon}${personal.nativePlace}`);
  if (personal.politicalStatus) parts.push(`${L.politicalStatus}${colon}${personal.politicalStatus}`);
  return parts.length ? parts.join(language === 'en' ? ' · ' : ' ｜ ') : null;
}

// ── Photo (WP-65): carried by the download request, never stored ─────────

const exportPhoto = new AsyncLocalStorage<Buffer>();

/** Run an export with a photo the user sent from their device (placed when the layout allows). */
export function withExportPhoto<T>(photo: Buffer | null | undefined, fn: () => Promise<T>): Promise<T> {
  return photo && photo.length ? exportPhoto.run(photo, fn) : fn();
}

/** 'jpg' | 'png' from the file's magic bytes, or null. */
export function photoTypeOf(photo: Buffer | null | undefined): 'jpg' | 'png' | null {
  if (!photo || photo.length < 8) return null;
  if (photo[0] === 0xff && photo[1] === 0xd8 && photo[2] === 0xff) return 'jpg';
  if (photo.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/** The photo this render places, or null. */
function photoFor(layout: ResumeRenderLayout, options: { photo?: Buffer | null }): Buffer | null {
  if (!layout.photo) return null;
  const photo = options.photo ?? exportPhoto.getStore() ?? null;
  return photoTypeOf(photo) ? photo : null;
}

/** Photo box in points (a one-inch ID photo, 25 × 35 mm). */
export const PHOTO_BOX = { width: 64, height: 90 } as const;

/** Pixel size from a PNG IHDR or a JPEG SOFn header, or null when unreadable. */
export function photoPixelSize(photo: Buffer | null | undefined): { width: number; height: number } | null {
  const type = photoTypeOf(photo);
  if (!photo || !type) return null;
  if (type === 'png') {
    if (photo.length < 24 || photo.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = photo.readUInt32BE(16);
    const height = photo.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // JPEG: walk the markers to the first start-of-frame (SOF0–SOF15 except DHT/JPG/DAC).
  let i = 2;
  while (i + 9 < photo.length) {
    if (photo[i] !== 0xff) return null;
    const marker = photo[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = photo.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = photo.readUInt16BE(i + 5);
      const width = photo.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** The photo's size inside PHOTO_BOX with its aspect ratio kept (the box when unreadable). */
export function fitPhotoBox(photo: Buffer | null | undefined): { width: number; height: number } {
  const size = photoPixelSize(photo);
  if (!size) return { width: PHOTO_BOX.width, height: PHOTO_BOX.height };
  const scale = Math.min(PHOTO_BOX.width / size.width, PHOTO_BOX.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
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
  /** A JPEG/PNG photo from the user's device (WP-65; never stored). Defaults to `withExportPhoto()`'s. */
  photo?: Buffer | null;
}

/**
 * The skills layout applied to the parsed sections: `inline` puts every skill
 * on one line (bullets joined with " · "). `columns` is drawn by the PDF.
 */
function applySkillsLayout(doc: ResumeDoc, layout: ResumeRenderLayout): ResumeDoc {
  if (layout.skillsLayout !== 'inline') return doc;
  return {
    ...doc,
    sections: doc.sections.map((s) => {
      if (!isSkillsSection(s.title)) return s;
      const items = s.blocks.filter((b) => b.kind === 'bullet' || b.kind === 'para').map((b) => b.text);
      if (items.length < 2) return s;
      const rest = s.blocks.filter((b) => b.kind !== 'bullet' && b.kind !== 'para');
      return { ...s, blocks: [...rest, { kind: 'para', text: items.join(' · ') }] };
    }),
  };
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
  return (await renderResumePdfWithMeta(markdown, options)).buffer;
}

/** Pages the PDF export of this markdown has with these options (fit-to-page, WP-65). */
export async function countResumePages(markdown: string, options: RenderOptions = {}): Promise<number> {
  return (await renderResumePdfWithMeta(markdown, options)).pages;
}

/** The PDF plus its page count. */
export async function renderResumePdfWithMeta(markdown: string, options: RenderOptions = {}): Promise<{ buffer: Buffer; pages: number }> {
  const layout = resolveLayout(options.layout, { page: options.defaultPage });
  const parsed0 = structure(parseResumeMarkdown(markdown), layout);
  const photo = photoFor(layout, options);
  const personal = personalLine(layout.personal, personalLanguage(layout, allText(parsed0), options.locale));
  const parsed = applySkillsLayout(personal ? { ...parsed0, header: [...parsed0.header, { kind: 'para', text: personal }] } : parsed0, layout);
  const text = allText(parsed, options.footerLine);
  const chain = fontChainForText(options.locale, text);

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

  type Weight = FontWeight;
  type TextOpts = RunTextOptions;
  const { draw, measure, fontName } = createRunDrawer(doc, {
    chain,
    stdRegular: layout.font === 'serif' ? 'Times-Roman' : 'Helvetica',
    stdBold: layout.font === 'serif' ? 'Times-Bold' : 'Helvetica-Bold',
    widthFrom: (x) => pw - x - marginX,
  });

  const left = marginX;
  const contentWidth = pw - marginX * 2;
  const bottomLimit = ph - marginY - footerReserve;
  const pageContent = bottomLimit - marginY;
  const lineGap = layout.spacing.line;
  const ink = '#222222';
  const sub = '#333333';
  const centered = layout.headerAlign === 'center';
  const sectionAlign = layout.template === 'centered' ? 'center' : 'left';

  // Header (name + contact lines + personal details) across the full width,
  // or beside the photo (top-right) when the request carries one.
  const photoGap = photo ? PHOTO_BOX.width + 12 : 0;
  const headerWidth = contentWidth - (centered ? photoGap * 2 : photoGap);
  const headerX = left + (centered ? photoGap : 0);
  if (photo) {
    doc.image(photo, left + contentWidth - PHOTO_BOX.width, marginY, { fit: [PHOTO_BOX.width, PHOTO_BOX.height], align: 'center', valign: 'top' });
  }
  if (parsed.name) {
    doc.fillColor('#111111');
    draw(parsed.name, 'bold', layout.sizes.name, headerX, doc.y, { width: headerWidth, align: centered ? 'center' : 'left' });
    doc.moveDown(0.2);
  }
  for (const b of parsed.header) {
    doc.fillColor(sub);
    draw(b.text, 'reg', layout.sizes.body, headerX, doc.y, { width: headerWidth, align: centered ? 'center' : 'left', lineGap });
  }
  if (photo && doc.y < marginY + PHOTO_BOX.height + 4) doc.y = marginY + PHOTO_BOX.height + 4;
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
    if (layout.template === 'campus') {
      // Campus: a short accent bar before the title.
      const barH = layout.sizes.section;
      doc.rect(x, doc.y + 1, 3, barH).fill(layout.accent);
      doc.fillColor(layout.accent);
      draw(title, 'bold', layout.sizes.section, x + 8, doc.y, { ...titleOpts, width: width - 8 });
    } else {
      draw(title, 'bold', layout.sizes.section, x, doc.y, titleOpts);
    }
    if (!layout.hideDivider && layout.template !== 'structured') {
      doc.moveTo(x, doc.y + 2).lineTo(x + width, doc.y + 2).strokeColor(layout.accent === DEFAULT_ACCENT ? '#cccccc' : layout.accent).lineWidth(0.6).stroke();
    }
    doc.y += 5;
    const bodyAlign: TextOpts['align'] = layout.justify ? 'justify' : 'left';
    if (layout.skillsLayout === 'columns' && isSkillsSection(s.title)) {
      // Two columns of skills: left half, then right half, from the same top.
      const items = s.blocks.filter((b) => b.kind === 'bullet' || b.kind === 'para');
      if (items.length >= 4) {
        const colW = (width - 12) / 2;
        const half = Math.ceil(items.length / 2);
        const rows = items.slice(0, half).map((b, i) => [b, items[half + i]] as const);
        for (const [a, b] of rows) {
          const ta = `${layout.bullet}  ${a.text}`;
          const tb = b ? `${layout.bullet}  ${b.text}` : '';
          const h = Math.max(measure(ta, 'reg', layout.sizes.body, colW, { lineGap }), tb ? measure(tb, 'reg', layout.sizes.body, colW, { lineGap }) : 0);
          guard(h);
          const top = doc.y;
          doc.fillColor(sub);
          draw(ta, 'reg', layout.sizes.body, x, top, { width: colW, lineGap });
          if (tb) draw(tb, 'reg', layout.sizes.body, x + colW + 12, top, { width: colW, lineGap });
          doc.y = top + h + 1;
        }
        return;
      }
    }
    for (const b of s.blocks) {
      if (b.kind === 'h3' || b.kind === 'h1' || b.kind === 'h2') {
        doc.y += layout.spacing.entry;
        guard(measure(b.text, 'bold', layout.sizes.sub, width, { lineGap }) + layout.sizes.body * 1.4);
        doc.fillColor(ink);
        draw(b.text, 'bold', layout.sizes.sub, x, doc.y, { width, lineGap });
        doc.y += 1;
      } else {
        const t = b.kind === 'bullet' ? `${layout.bullet}  ${b.text}` : b.text;
        guard(measure(t, 'reg', layout.sizes.body, width, { lineGap }));
        doc.fillColor(sub);
        draw(t, 'reg', layout.sizes.body, x, doc.y, { width, lineGap, align: bodyAlign });
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
    doc.font(fontName('std', 'reg')).fontSize(10).fillColor('#999999').text('(empty resume)', left, marginY);
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

  const pages = doc.bufferedPageRange().count;
  return { buffer: await pdfToBuffer(doc), pages };
}

const HEX = (c: string) => c.replace('#', '').toUpperCase();

/**
 * The author written into a .docx: the given name, or a blank. Never the
 * docx library's default ("Un-named"). A single space, because the library
 * falls back to its default for an empty string.
 */
export function docxAuthor(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || ' ';
}

/**
 * Render resume markdown to a Word .docx (Buffer). Word supplies its own CJK
 * fonts, so nothing is embedded; the AI marks go into custom properties.
 */
export async function renderResumeDocx(markdown: string, options: RenderOptions = {}): Promise<Buffer> {
  const layout = resolveLayout(options.layout, { page: options.defaultPage });
  const parsed0 = structure(parseResumeMarkdown(markdown), layout);
  const personal = personalLine(layout.personal, personalLanguage(layout, allText(parsed0), options.locale));
  const parsed = applySkillsLayout(personal ? { ...parsed0, header: [...parsed0.header, { kind: 'para', text: personal }] } : parsed0, layout);
  const photo = photoFor(layout, options);
  const photoType = photoTypeOf(photo);
  const bodyAlign = layout.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT;
  const wordBullet = layout.bullet === '•';
  const centered = layout.headerAlign === 'center';
  const halfPt = (pt: number) => Math.round(pt * 2);
  const latinFont = layout.font === 'serif' ? 'Times New Roman' : 'Arial';
  const run = (text: string, opts: { bold?: boolean; size: number; color?: string; caps?: boolean }) =>
    new TextRun({ text, bold: opts.bold, size: halfPt(opts.size), color: opts.color, allCaps: opts.caps, font: latinFont });

  const children: Paragraph[] = [];
  if (photo && photoType) {
    // Top-right of the first page, text wraps around it (96 px per inch).
    const px = (pt: number) => Math.max(1, Math.round((pt / 72) * 96));
    const box = fitPhotoBox(photo);
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: photoType,
            data: photo,
            transformation: { width: px(box.width), height: px(box.height) },
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, align: HorizontalPositionAlign.RIGHT },
              verticalPosition: { relative: VerticalPositionRelativeFrom.MARGIN, align: VerticalPositionAlign.TOP },
              wrap: { type: TextWrappingType.SQUARE },
            },
          }),
        ],
      }),
    );
  }
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
        children.push(
          wordBullet
            ? new Paragraph({ bullet: { level: 0 }, alignment: bodyAlign, spacing: { after: twip(layout.spacing.line) }, children: [run(b.text, { size: layout.sizes.body, color: '333333' })] })
            : new Paragraph({ alignment: bodyAlign, spacing: { after: twip(layout.spacing.line) }, children: [run(`${layout.bullet}  ${b.text}`, { size: layout.sizes.body, color: '333333' })] }),
        );
      } else if (b.kind === 'para') {
        children.push(new Paragraph({ alignment: bodyAlign, spacing: { after: twip(layout.spacing.line + 2) }, children: [run(b.text, { size: layout.sizes.body, color: '333333' })] }));
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
    // The author is the person whose resume it is (the library's default is
    // the literal "Un-named", which showed in Word's file properties).
    creator: docxAuthor(parsed.name),
    lastModifiedBy: docxAuthor(parsed.name),
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
