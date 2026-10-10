// server/src/features/coverletter/letterExport.ts
//
// PDF / DOCX export of a cover letter (WP-37; ARCH §3.6; CN-E-07).
//
// Same libraries (pdfkit, docx) and the same bundled CJK faces
// (server/assets/fonts, Noto Sans SC and — when WP-36b ships it — TC) as the
// resume exporter in roboapply/v2/lib/resumeExport.ts. That module's
// renderers take only markdown, so they cannot carry the AI label; this one
// adds what a letter export needs:
//   - the machine-readable AI label from compliance `implicitLabelMetadata()`
//     on both brands: PDF Info keys + an XMP packet, DOCX custom properties;
//   - the visible footer line from `explicitFooterLine()` when the brand
//     turned it on (GoApply, CN_AI_EXPORT_EXPLICIT_LABEL);
//   - letter layout (A4/Letter by locale, paragraphs, sign-off).
// Pure apart from reading the font files; no DB, no LLM.

/// <reference path="./pdfkit.d.ts" />

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { CJK_RE } from './claimCheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// features/coverletter → up 3 to server/, then assets/fonts.
const FONT_DIR = path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts');

interface FontPair {
  regular: string;
  bold: string;
}

function fontPair(family: 'SC' | 'TC'): FontPair | null {
  const regular = path.join(FONT_DIR, `NotoSans${family}-Regular.ttf`);
  const bold = path.join(FONT_DIR, `NotoSans${family}-Bold.ttf`);
  return fs.existsSync(regular) && fs.existsSync(bold) ? { regular, bold } : null;
}

/** The bundled CJK faces for a locale (zh-TW prefers TC, falls back to SC), or null (Latin-only Helvetica). */
export function cjkFontsFor(locale: string): FontPair | null {
  if (locale === 'zh-TW') return fontPair('TC') ?? fontPair('SC');
  return fontPair('SC') ?? fontPair('TC');
}

/**
 * True when a PDF of this text would print correctly: Latin-only text, or
 * CJK text with the bundled CJK faces present. Helvetica has no CJK glyphs,
 * so without the fonts a Chinese letter would download as an unreadable file;
 * the exporter refuses it instead (Word is unaffected).
 */
export function pdfFontsAvailable(texts: ReadonlyArray<string | null | undefined>, locale: string): boolean {
  if (!texts.some((t) => t && CJK_RE.test(t))) return true;
  return cjkFontsFor(locale) !== null;
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
  const fonts = cjkFontsFor(input.locale);
  const doc = new PDFDocument({
    size: paperFor(input.locale),
    margin: 64,
    // ≥1.4 so pdfkit writes the XMP metadata stream.
    pdfVersion: '1.7',
    lang: input.locale,
    info: { Title: input.title, ...input.label.pdfInfo },
  });
  doc.appendXML(input.label.xmp);
  const regular = fonts ? 'CLReg' : 'Helvetica';
  if (fonts) {
    doc.registerFont('CLReg', fonts.regular);
    doc.registerFont('CLBold', fonts.bold);
  }
  const width = doc.page.width - 128;
  const paragraphs = letterParagraphs(input.body);
  for (const lines of paragraphs) {
    doc.font(regular).fontSize(11).fillColor('#222222').text(lines.join('\n'), { width, lineGap: 3 });
    doc.moveDown(0.9);
  }
  if (paragraphs.length === 0) doc.font(regular).fontSize(11).fillColor('#999999').text(' ');
  if (input.footerLine) {
    doc.moveDown(1.2);
    doc.font(regular).fontSize(8.5).fillColor('#666666').text(input.footerLine, { width });
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
