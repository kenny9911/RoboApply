// server/src/features/coverletter/letterExport.ts
//
// PDF / DOCX export of a cover letter (WP-37; ARCH §3.6; CN-E-07).
//
// Same libraries (pdfkit, docx) as the resume exporter, and — since INT-10 —
// the same per-run font chain (roboapply/v2/lib/resumeExport.ts
// `fontChainForText` + `createRunDrawer`): each run of a line is drawn in the
// first face that has its glyphs. The PDF standard face draws Latin text; the
// bundled faces follow in the order of the letter's locale, so a Korean
// letter prints in Noto Sans KR, a zh-TW letter in the Traditional face (Han
// Sans TC, or Noto Sans TC when present) and a zh letter in Noto Sans SC,
// with the other faces behind for characters the first one lacks.
// What a letter export adds to that:
//   - the machine-readable AI label from compliance `implicitLabelMetadata()`
//     on both brands: PDF Info keys + an XMP packet, DOCX custom properties;
//   - the visible footer line from `explicitFooterLine()` when the brand
//     turned it on (GoApply, CN_AI_EXPORT_EXPLICIT_LABEL);
//   - letter layout (A4/Letter by locale, paragraphs, sign-off).
// Pure apart from reading the font files; no DB, no LLM.

/// <reference path="./pdfkit.d.ts" />

import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import {
  bundledFace,
  createRunDrawer,
  docxAuthor,
  faceHasGlyph,
  fontChainForText,
  hanOrderFor,
  splitFontRuns,
  type FaceKey,
  type FontFaces,
  type FontRun,
} from '../../roboapply/v2/lib/resumeExport.js';

interface FontPair {
  regular: string;
  bold: string;
}

/**
 * The primary bundled Han/Hangul/kana face for a locale (zh-TW → TC, ko → KR,
 * ja → JP, otherwise SC), falling back along the locale's order; null when
 * none is bundled (the PDF standard face then draws Latin-only letters).
 */
export function cjkFontsFor(locale: string): FontPair | null {
  for (const key of hanOrderFor(locale)) {
    const face = bundledFace(key);
    if (face) return { regular: face.regular, bold: face.bold };
  }
  return null;
}

/** The fallback chain a letter's text needs (empty for text the PDF standard face draws). */
export function letterFontChain(texts: ReadonlyArray<string | null | undefined>, locale: string): FontFaces[] {
  return fontChainForText(locale, texts.filter(Boolean).join('\n'));
}

/** The text of a letter split by the font each run prints in (`std` = the PDF standard face). */
export function letterFontRuns(text: string, locale: string): FontRun[] {
  const chain = letterFontChain([text], locale);
  return chain.length ? splitFontRuns(text, chain) : [{ text, face: 'std' }];
}

/** Scripts a PDF must have a bundled face for: without one the whole text is boxes. */
const SCRIPTS: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  ['han', /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u],
  ['hangul', /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/u],
  ['kana', /[\u3040-\u30ff\u31f0-\u31ff]/u],
];

/**
 * True when a PDF of this text would print correctly: text the standard face
 * draws, or text whose scripts each have a bundled face that draws them
 * (Hangul needs the KR face, kana the JP face, Han any Han face). Without the
 * face a Chinese or Korean letter would download as an unreadable file; the
 * exporter refuses it instead (Word is unaffected). A single rare character
 * no face has never blocks the PDF.
 */
export function pdfFontsAvailable(texts: ReadonlyArray<string | null | undefined>, locale: string): boolean {
  const text = texts.filter(Boolean).join('\n');
  const chain = letterFontChain(texts, locale);
  for (const [, re] of SCRIPTS) {
    const chars = [...text].filter((ch) => re.test(ch));
    if (chars.length === 0) continue;
    if (!chars.some((ch) => chain.some((face) => faceHasGlyph(face, ch.codePointAt(0)!)))) return false;
  }
  return true;
}

/** The bundled faces a letter PDF embeds, in the order they were first used. */
export function letterFacesUsed(texts: ReadonlyArray<string | null | undefined>, locale: string): FaceKey[] {
  const used: FaceKey[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const run of letterFontRuns(t, locale)) if (run.face !== 'std' && !used.includes(run.face)) used.push(run.face);
  }
  return used;
}

/** The label fields compliance hands to exporters (subset of ImplicitAiLabel). */
export interface ExportAiLabel {
  pdfInfo: Record<string, string>;
  docxCustomProperties: Record<string, string>;
  xmp: string;
}

export interface LetterExportInput {
  body: string;
  title: string;
  locale: string;
  label: ExportAiLabel;
  /** Visible AI line printed under the letter, or null. */
  footerLine: string | null;
  /** The person the letter is from, for the Word file's author property (blank when not known). */
  author?: string | null;
}

/** Paragraphs of the body (blank-line separated; single newlines kept as line breaks). */
export function letterParagraphs(body: string): string[][] {
  return (body ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0);
}

/** US/CA letters print on Letter; everywhere else A4. */
export function paperFor(locale: string): 'LETTER' | 'A4' {
  return locale === 'en' ? 'LETTER' : 'A4';
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

/** Thrown by renderLetterPdf when the text needs CJK faces that are not bundled. */
export class PdfFontUnavailableError extends Error {
  constructor() {
    super('pdf_font_unavailable');
    this.name = 'PdfFontUnavailableError';
  }
}

export async function renderLetterPdf(input: LetterExportInput): Promise<Buffer> {
  if (!pdfFontsAvailable([input.body, input.footerLine], input.locale)) throw new PdfFontUnavailableError();
  const margin = 64;
  const doc = new PDFDocument({
    size: paperFor(input.locale),
    margin,
    // ≥1.4 so pdfkit writes the XMP metadata stream.
    pdfVersion: '1.7',
    lang: input.locale,
    info: { Title: input.title, ...input.label.pdfInfo },
  });
  doc.appendXML(input.label.xmp);
  const width = doc.page.width - margin * 2;
  // The resume exporter's per-run chain: every line is drawn run by run, each
  // run in the first face that has its glyphs.
  const { draw, fontName } = createRunDrawer(doc, {
    chain: letterFontChain([input.body, input.footerLine], input.locale),
    widthFrom: (x) => doc.page.width - x - margin,
  });
  const paragraphs = letterParagraphs(input.body);
  for (const lines of paragraphs) {
    doc.fillColor('#222222');
    for (const line of lines) draw(line, 'reg', 11, margin, doc.y, { width, lineGap: 3 });
    doc.moveDown(0.9);
  }
  if (paragraphs.length === 0) doc.font(fontName('std', 'reg')).fontSize(11).fillColor('#999999').text(' ');
  if (input.footerLine) {
    doc.moveDown(1.2);
    doc.fillColor('#666666');
    draw(input.footerLine, 'reg', 8.5, margin, doc.y, { width });
  }
  return pdfToBuffer(doc);
}

export async function renderLetterDocx(input: LetterExportInput): Promise<Buffer> {
  const children: Paragraph[] = [];
  for (const lines of letterParagraphs(input.body)) {
    const runs: TextRun[] = lines.map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined }));
    children.push(new Paragraph({ children: runs, spacing: { after: 200 } }));
  }
  if (children.length === 0) children.push(new Paragraph({ text: '' }));
  if (input.footerLine) children.push(new Paragraph({ children: [new TextRun({ text: input.footerLine, size: 16, color: '666666' })], spacing: { before: 240 } }));
  const doc = new Document({
    title: input.title,
    // No author is known here; a blank, never the library's default "Un-named".
    creator: docxAuthor(input.author),
    lastModifiedBy: docxAuthor(input.author),
    customProperties: Object.entries(input.label.docxCustomProperties).map(([name, value]) => ({ name, value })),
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A download name: "Cover letter - <title>.pdf" with characters filesystems reject removed. */
export function letterFileName(title: string, format: 'pdf' | 'docx', prefix = 'Cover letter'): string {
  const clean = (title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${clean ? `${prefix} - ${clean}` : prefix}.${format}`;
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
