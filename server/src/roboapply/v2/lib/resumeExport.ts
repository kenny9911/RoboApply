// backend/src/roboapply/v2/lib/resumeExport.ts
//
// Server-side export of a RoboApply resume variant's markdown to a real,
// downloadable file. Closes the Resume Builder's single largest production gap:
// previously "Download PDF" was a client-side window.print() of the dark editor
// UI and "Download DOCX" was a dead button — a user who built or tailored a
// resume could not get a clean file of it. This renders the resume markdown
// itself (name → sections → roles → bullets) into a polished document.
//
// Two pure entry points (no DB, no LLM — deterministically testable, see
// scripts/raAcceptanceResume.ts):
//   parseResumeMarkdown(md) → ResumeBlock[]   (structure the route + renderers share)
//   renderResumePdf(md)     → Promise<Buffer> (application/pdf; CJK-safe via Noto SC)
//   renderResumeDocx(md)    → Promise<Buffer> (Word .docx via the `docx` lib)
//
// CJK: pdfkit's built-in PDF fonts have no CJK glyphs, so we register the
// bundled Noto Sans SC faces (assets/fonts) used by JobExportService; absent
// those, we fall back to Helvetica (Latin-only) rather than crash.

import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/ is backend/src/roboapply/v2/lib → up 4 to backend/, then assets/fonts.
const FONT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'NotoSansSC-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSansSC-Bold.ttf');
const HAS_FONTS = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);

/** True when the bundled Noto Sans SC faces are present, so CJK resumes embed
 *  real glyphs rather than tofu boxes. Surfaced for the acceptance oracle. */
export function hasCjkFonts(): boolean {
  return HAS_FONTS;
}

export type ResumeBlockKind = 'h1' | 'h2' | 'h3' | 'bullet' | 'para';

export interface ResumeBlock {
  kind: ResumeBlockKind;
  text: string;
}

/** Strip inline markdown emphasis/link syntax to plain text for layout — the
 *  renderers carry weight via fonts, not inline runs. Keeps link text + url. */
function stripInline(s: string): string {
  return s
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
 * (#/##/###), bullets (-, *, •) and paragraphs; horizontal rules and blank
 * lines are dropped. Pure + deterministic — the acceptance oracle asserts the
 * block structure directly.
 */
export function parseResumeMarkdown(markdown: string): ResumeBlock[] {
  const blocks: ResumeBlock[] = [];
  for (const raw of (markdown ?? '').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue; // horizontal rule
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^#\s+(.*)$/))) blocks.push({ kind: 'h1', text: stripInline(m[1]) });
    else if ((m = t.match(/^##\s+(.*)$/))) blocks.push({ kind: 'h2', text: stripInline(m[1]) });
    else if ((m = t.match(/^#{3,}\s+(.*)$/))) blocks.push({ kind: 'h3', text: stripInline(m[1]) });
    else if ((m = t.match(/^[-*•]\s+(.*)$/))) blocks.push({ kind: 'bullet', text: stripInline(m[1]) });
    else blocks.push({ kind: 'para', text: stripInline(t) });
  }
  return blocks;
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

/**
 * Render resume markdown to a clean A4 PDF (Buffer). CJK-safe. Never renders
 * editor chrome — only the resume content.
 */
export async function renderResumePdf(markdown: string): Promise<Buffer> {
  const blocks = parseResumeMarkdown(markdown);
  const doc = new PDFDocument({
    size: 'A4',
    margin: 54,
    bufferPages: true,
    info: { Title: 'Resume' },
  });

  const fontReg = HAS_FONTS ? 'RZReg' : 'Helvetica';
  const fontBold = HAS_FONTS ? 'RZBold' : 'Helvetica-Bold';
  if (HAS_FONTS) {
    doc.registerFont('RZReg', FONT_REGULAR);
    doc.registerFont('RZBold', FONT_BOLD);
  }

  const contentWidth = doc.page.width - 108; // 54 margin each side
  const left = 54;
  const bottomLimit = doc.page.height - 60;
  const guard = (reserve: number) => {
    if (doc.y > bottomLimit - reserve) doc.addPage();
  };

  let first = true;
  for (const b of blocks) {
    switch (b.kind) {
      case 'h1':
        doc.font(fontBold).fontSize(22).fillColor('#111111').text(b.text, { width: contentWidth });
        doc.moveDown(0.25);
        break;
      case 'h2':
        if (!first) doc.moveDown(0.6);
        guard(34);
        doc.font(fontBold).fontSize(12.5).fillColor('#1a1a1a').text(b.text, { width: contentWidth });
        doc
          .moveTo(left, doc.y + 2)
          .lineTo(left + contentWidth, doc.y + 2)
          .strokeColor('#cccccc')
          .lineWidth(0.6)
          .stroke();
        doc.moveDown(0.45);
        break;
      case 'h3':
        doc.moveDown(0.3);
        guard(22);
        doc.font(fontBold).fontSize(10.8).fillColor('#222222').text(b.text, { width: contentWidth });
        doc.moveDown(0.12);
        break;
      case 'bullet':
        guard(16);
        doc
          .font(fontReg)
          .fontSize(9.8)
          .fillColor('#333333')
          .text(`•  ${b.text}`, { width: contentWidth, indent: 8, lineGap: 2 });
        doc.moveDown(0.1);
        break;
      case 'para':
        guard(16);
        doc
          .font(fontReg)
          .fontSize(9.8)
          .fillColor('#333333')
          .text(b.text, { width: contentWidth, lineGap: 2 });
        doc.moveDown(0.2);
        break;
    }
    first = false;
  }

  // Empty/blank resume → still emit a valid one-line PDF rather than throw.
  if (blocks.length === 0) {
    doc.font(fontReg).fontSize(10).fillColor('#999999').text('(empty resume)');
  }

  return pdfToBuffer(doc);
}

/**
 * Render resume markdown to a Word .docx (Buffer). Word supplies its own CJK
 * fonts, so no font embedding is needed — the text runs carry Unicode as-is.
 */
export async function renderResumeDocx(markdown: string): Promise<Buffer> {
  const blocks = parseResumeMarkdown(markdown);
  const children: Paragraph[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'h1':
        children.push(new Paragraph({ text: b.text, heading: HeadingLevel.TITLE }));
        break;
      case 'h2':
        children.push(
          new Paragraph({
            text: b.text,
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 220, after: 80 },
          }),
        );
        break;
      case 'h3':
        children.push(
          new Paragraph({
            text: b.text,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 120, after: 40 },
          }),
        );
        break;
      case 'bullet':
        children.push(new Paragraph({ text: b.text, bullet: { level: 0 } }));
        break;
      case 'para':
        children.push(new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 60 } }));
        break;
    }
  }
  if (children.length === 0) children.push(new Paragraph({ text: '(empty resume)' }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
