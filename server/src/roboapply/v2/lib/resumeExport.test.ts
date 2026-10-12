// @vitest-environment node
// WP-36b: resume export renderers (server/src/roboapply/v2/lib/resumeExport.ts)
// — templates, layout, page size, dates, file names, AI marks, per-run font
// fallback (Latin Extended, Greek, Cyrillic, Hangul, kana, zh and zh-TW), and
// two-column paging.
//
// Sits next to the module (moved from components/features/resume/server by INT-10).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { implicitLabelMetadata } from '../../../features/compliance/aiLabel.js';

type FaceKey = 'latin' | 'sc' | 'tc' | 'kr' | 'jp';
interface FontFaces {
  key: FaceKey;
  family: string;
  regular: string;
  bold: string;
}
type Opts = Record<string, unknown>;
interface ExportModule {
  RESUME_TEMPLATE_KEYS: readonly string[];
  FONT_DIR: string;
  buildExportFileName(style: string | null, parts: Opts & { fallback: string }): string;
  bundledFace(key: FaceKey): FontFaces | null;
  bodyLanguage(blocks: Array<{ kind: string; text: string }>): 'en' | 'zh' | 'zh-TW';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRunDrawer(doc: any, config: { chain: readonly FontFaces[]; widthFrom: (x: number) => number }): { draw: (...a: any[]) => void; measure: (...a: any[]) => number };
  containsCjk(text: string): boolean;
  defaultPageFor(input: Opts): 'letter' | 'a4';
  faceHasGlyph(face: FontFaces, cp: number): boolean;
  fontChainFor(locale?: string | null, text?: string): FontFaces[];
  formatDatesIn(text: string, format: string): string;
  hanOrderFor(locale?: string | null, text?: string): FaceKey[];
  hasCjkFonts(): boolean;
  isSidebarSection(title: string): boolean;
  needsUnicodeFont(text: string): boolean;
  normalizeTemplate(v: unknown): string;
  parseResumeMarkdown(md: string): Array<{ kind: string; text: string }>;
  renderResumeDocx(md: string, options?: Opts): Promise<Buffer>;
  renderResumePdf(md: string, options?: Opts): Promise<Buffer>;
  resolveLayout(raw: unknown, defaults?: Opts): Record<string, any>;
  splitFontRuns(text: string, chain: readonly FontFaces[]): Array<{ text: string; face: FaceKey | 'std' }>;
  unicodeFontFor(locale?: string | null): FontFaces | null;
}
const EXPORT_MODULE = './resumeExport.js';
const X = (await import(/* @vite-ignore */ EXPORT_MODULE)) as ExportModule;
const {
  buildExportFileName,
  bundledFace,
  containsCjk,
  defaultPageFor,
  faceHasGlyph,
  fontChainFor,
  formatDatesIn,
  hanOrderFor,
  hasCjkFonts,
  isSidebarSection,
  needsUnicodeFont,
  normalizeTemplate,
  parseResumeMarkdown,
  renderResumeDocx,
  renderResumePdf,
  resolveLayout,
  splitFontRuns,
  unicodeFontFor,
  RESUME_TEMPLATE_KEYS,
} = X;

const EN = `# Ada Lovelace

London · ada@example.com

## Experience

**Analytical Engines** — Engineer · March 2021 – Present
- Wrote the first program
- Cut run time by 40%

## Skills

Mathematics · Programming

## Education

**University of London** — BSc · 2015
`;

const ZH = `# 王小明

上海 · ming@example.com

## 工作经历

**某某科技** — 后端工程师 · 2021-03 – 至今
- 负责简历导出功能

## 技能

TypeScript · 数据库
`;

const ZH_TW = `# 陳美玲

臺北市 · ling@example.com

## 工作經歷

**範例股份有限公司** — 軟體工程師
- 負責履歷匯出與繁體中文排版

## 技能

資料庫 · 雲端服務
`;

const latin1 = (b: Buffer) => b.toString('latin1');
const baseFonts = (b: Buffer) => latin1(b).match(/\/BaseFont \/[A-Z]{6}\+[\w-]+/g) ?? [];
const mediaBox = (b: Buffer) => latin1(b).match(/\/MediaBox \[([^\]]+)\]/)?.[1]?.trim().split(/\s+/).map(Number);

/** Content streams in file order (pdfkit writes them page by page), inflated. */
function contentStreams(buf: Buffer): string[] {
  const s = latin1(buf);
  const out: string[] = [];
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = s.indexOf('endstream', start);
    try {
      out.push(zlib.inflateSync(buf.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1'));
    } catch {
      // Not a deflated stream (or a font program we do not need).
    }
  }
  return out.filter((c) => /\bTf\b/.test(c));
}

/** Resource name (F1, F2…) → whether it is an embedded Type0 (CID) font. */
function type0Fonts(buf: Buffer): Map<string, boolean> {
  const s = latin1(buf);
  const out = new Map<string, boolean>();
  for (const m of s.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const at = s.indexOf(`\n${m[2]} 0 obj`);
    const body = at >= 0 ? s.slice(at, s.indexOf('endobj', at)) : '';
    out.set(m[1]!, /\/Subtype \/Type0/.test(body));
  }
  return out;
}

/** How many .notdef glyphs (glyph id 0, drawn as a box) the PDF shows. */
function notdefCount(buf: Buffer): number {
  const cid = type0Fonts(buf);
  let zeros = 0;
  for (const c of contentStreams(buf)) {
    let font = '';
    for (const t of c.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>/g)) {
      if (t[1]) font = t[1];
      else if (cid.get(font)) for (let k = 0; k + 4 <= t[2]!.length; k += 4) if (t[2]!.slice(k, k + 4) === '0000') zeros += 1;
    }
  }
  return zeros;
}

/** Text drawn with the standard (WinAnsi) faces, one string per page. */
function pageTexts(buf: Buffer): string[] {
  const cid = type0Fonts(buf);
  return contentStreams(buf).map((c) => {
    let font = '';
    let text = '';
    for (const t of c.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>/g)) {
      if (t[1]) font = t[1];
      else if (!cid.get(font)) text += Buffer.from(t[2]!, 'hex').toString('latin1');
    }
    return text;
  });
}

/** Read one entry of a zip (docx) archive with node's zlib (no extra deps). */
function zipEntry(buf: Buffer, name: string): string | null {
  let i = 0;
  while ((i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i)) !== -1) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const entry = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    if (entry === name) {
      const data = buf.subarray(start, start + compSize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    // `start` is already past this header, so an empty entry (a folder) still
    // moves on; adding a byte here used to skip the entry right after a folder.
    i = start + compSize;
  }
  return null;
}

describe('parseResumeMarkdown', () => {
  it('reads headings, role lines, bullets and paragraphs', () => {
    const blocks = parseResumeMarkdown(EN);
    expect(blocks[0]).toEqual({ kind: 'h1', text: 'Ada Lovelace' });
    expect(blocks.find((b) => b.kind === 'h3')?.text).toBe('Analytical Engines — Engineer · March 2021 – Present');
    expect(blocks.filter((b) => b.kind === 'bullet')).toHaveLength(2);
    expect(blocks.some((b) => b.text.includes('**'))).toBe(false);
  });

  it('a labelled skills line is body text, not a role heading', () => {
    const blocks = parseResumeMarkdown('## Skills\n**Tools:** Zendesk · Jira\n**框架：** pandas\n## Experience\n**Lead — Acme** · 2021 – Present');
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ['h2', 'Skills'],
      ['para', 'Tools: Zendesk · Jira'],
      ['para', '框架： pandas'],
      ['h2', 'Experience'],
      ['h3', 'Lead — Acme · 2021 – Present'],
    ]);
  });

  it('drops images and rules', () => {
    expect(parseResumeMarkdown('# A\n---\n![me](x.png)\n')).toEqual([{ kind: 'h1', text: 'A' }]);
  });
});

describe('resolveLayout', () => {
  it('fills template defaults and clamps out-of-range values', () => {
    const l = resolveLayout({ template: 'compact', spacing: { marginX: 5 }, accent: 'red', sizes: { body: 40 } });
    expect(l.template).toBe('compact');
    expect(l.spacing.marginX).toBe(28);
    expect(l.sizes.body).toBe(12);
    expect(l.accent).toBe('#1a1a1a');
    expect(l.page).toBe('letter');
  });

  it('maps legacy template names and honours the page default', () => {
    expect(normalizeTemplate('two-column')).toBe('two_column');
    expect(normalizeTemplate('split')).toBe('two_column');
    expect(normalizeTemplate('ats-clean')).toBe('standard');
    expect(resolveLayout(null, { page: 'a4' }).page).toBe('a4');
    expect(resolveLayout({ page: 'letter' }, { page: 'a4' }).page).toBe('letter');
    expect(resolveLayout({ template: 'centered' }).headerAlign).toBe('center');
  });
});

describe('defaultPageFor (Letter/A4 by country)', () => {
  it.each([
    [{ market: 'cn', country: 'US' }, 'a4'],
    [{ market: 'intl', country: 'US' }, 'letter'],
    [{ market: 'intl', country: 'TW' }, 'a4'],
    [{ market: 'intl', country: 'GB' }, 'a4'],
    [{ market: 'intl', locale: 'en' }, 'letter'],
    [{ market: 'intl', locale: 'zh-TW' }, 'a4'],
    [{ market: 'intl', locale: 'de' }, 'a4'],
    [{ market: 'intl', locale: 'en-CA' }, 'letter'],
  ])('%j → %s', (input, page) => {
    expect(defaultPageFor(input)).toBe(page);
  });
});

describe('formatDatesIn', () => {
  it('rewrites month-year dates and leaves words and bare years alone', () => {
    const line = 'Engineer · March 2021 – Present; 2019-07 – 02/2020; since 2018';
    expect(formatDatesIn(line, 'MM/YYYY')).toBe('Engineer · 03/2021 – Present; 07/2019 – 02/2020; since 2018');
    expect(formatDatesIn(line, 'Mon YYYY')).toBe('Engineer · Mar 2021 – Present; Jul 2019 – Feb 2020; since 2018');
    expect(formatDatesIn(line, 'YYYY')).toBe('Engineer · 2021 – Present; 2019 – 2020; since 2018');
    expect(formatDatesIn(line, 'as_written')).toBe(line);
  });
});

describe('buildExportFileName', () => {
  const parts = { name: 'Ada Lovelace', company: 'Acme/Inc', role: 'Engineer', date: new Date('2026-10-10T00:00:00Z'), fallback: 'My resume' };
  it('builds each preset from data we hold', () => {
    expect(buildExportFileName('name_company_role', parts)).toBe('Ada Lovelace - Acme Inc - Engineer');
    expect(buildExportFileName('name_role', parts)).toBe('Ada Lovelace - Engineer');
    expect(buildExportFileName('company_role_name', parts)).toBe('Acme Inc - Engineer - Ada Lovelace');
    expect(buildExportFileName('name_date', parts)).toBe('Ada Lovelace - 2026-10-10');
  });
  it('skips missing parts and falls back to the resume name', () => {
    expect(buildExportFileName('name_company_role', { ...parts, company: null })).toBe('Ada Lovelace - Engineer');
    expect(buildExportFileName(null, parts)).toBe('My resume');
    expect(buildExportFileName('name_company_role', { fallback: '' })).toBe('Resume');
  });
});

describe('font choice', () => {
  it('uses the PDF standard faces for Latin text and a Unicode face otherwise', () => {
    expect(needsUnicodeFont('Café – “quoted” • €5')).toBe(false);
    expect(needsUnicodeFont('Łódź')).toBe(true);
    expect(needsUnicodeFont('王小明')).toBe(true);
    expect(containsCjk('王小明')).toBe(true);
    expect(containsCjk('Ada')).toBe(false);
  });

  it('sends the two-column sidebar the right sections', () => {
    expect(isSidebarSection('Skills')).toBe(true);
    expect(isSidebarSection('教育背景')).toBe(true);
    expect(isSidebarSection('Experience')).toBe(false);
  });
});

describe('renderResumePdf', () => {
  it.each(RESUME_TEMPLATE_KEYS)('renders the %s template', async (template) => {
    const buf = await renderResumePdf(EN, { layout: { template } });
    expect(latin1(buf).startsWith('%PDF-1.7')).toBe(true);
    expect(buf.length).toBeGreaterThan(800);
  });

  it('uses Letter or A4 from the layout or the default', async () => {
    expect(mediaBox(await renderResumePdf(EN, { layout: { page: 'letter' } }))).toEqual([0, 0, 612, 792]);
    const a4 = mediaBox(await renderResumePdf(EN, { defaultPage: 'a4' }));
    expect(a4?.[2]).toBeCloseTo(595.28, 1);
  });

  it('keeps Latin-only resumes on the standard faces (no embedded font)', async () => {
    const buf = await renderResumePdf(EN);
    expect(baseFonts(buf)).toHaveLength(0);
    expect(latin1(buf)).toContain('/BaseFont /Helvetica');
  });

  it('serif font option uses Times', async () => {
    expect(latin1(await renderResumePdf(EN, { layout: { font: 'serif' } }))).toContain('/BaseFont /Times-Roman');
  });

  it('never throws on an empty resume', async () => {
    expect((await renderResumePdf('')).length).toBeGreaterThan(300);
  });
});

describe('CJK font embedding (TW-04, GoApply)', () => {
  it('ships the bundled Noto Sans SC faces', () => {
    expect(hasCjkFonts()).toBe(true);
  });

  it('embeds Noto Sans SC for a Simplified Chinese resume, every glyph real', async () => {
    const buf = await renderResumePdf(ZH, { locale: 'zh' });
    const fonts = baseFonts(buf);
    expect(fonts.some((f) => f.includes('NotoSansSC-Regular'))).toBe(true);
    expect(fonts.some((f) => f.includes('NotoSansSC-Bold'))).toBe(true);
    expect(latin1(buf)).toContain('/FontFile2');
    expect(notdefCount(buf)).toBe(0);
  });

  it('embeds the Traditional Chinese face for zh-TW, every glyph real', async () => {
    const faces = unicodeFontFor('zh-TW');
    expect(faces?.key).toBe('tc');
    expect(['NotoSansTC', 'HanSansTC']).toContain(faces!.family);
    const buf = await renderResumePdf(ZH_TW, { locale: 'zh-TW' });
    const fonts = baseFonts(buf);
    expect(fonts.some((f) => f.includes(`${faces!.family}-Regular`))).toBe(true);
    expect(fonts.some((f) => f.includes(`${faces!.family}-Bold`))).toBe(true);
    expect(fonts.some((f) => f.includes('NotoSansSC'))).toBe(false);
    expect(notdefCount(buf)).toBe(0);
    // Every character of the sample has a glyph in the TC face itself.
    const missing = [...new Set(ZH_TW.replace(/[\s\x00-\x7f]/g, ''))].filter((ch) => !faceHasGlyph(faces!, ch.codePointAt(0)!));
    expect(missing).toEqual([]);
  });

  it('picks a face for CJK text even without a locale', async () => {
    const buf = await renderResumePdf(ZH);
    expect(baseFonts(buf).length).toBeGreaterThan(0);
    expect(notdefCount(buf)).toBe(0);
  });
});

describe('font fallback per run (Latin Extended, Greek, Cyrillic, Hangul, kana)', () => {
  it('ships every bundled face (OFL) within the 20 MB budget', () => {
    for (const key of ['latin', 'sc', 'tc', 'kr', 'jp'] as const) expect(bundledFace(key), key).not.toBeNull();
    const total = fs.readdirSync(X.FONT_DIR).reduce((n, f) => n + fs.statSync(path.join(X.FONT_DIR, f)).size, 0);
    expect(total).toBeLessThan(20_000_000);
    expect(fs.existsSync(path.join(X.FONT_DIR, 'OFL.txt'))).toBe(true);
  });

  it('orders the Han faces by locale, then by script', () => {
    expect(hanOrderFor('zh')[0]).toBe('sc');
    expect(hanOrderFor('zh-TW')[0]).toBe('tc');
    expect(hanOrderFor('ja')[0]).toBe('jp');
    expect(hanOrderFor('ko')[0]).toBe('kr');
    expect(hanOrderFor(null, 'カタカナ')[0]).toBe('jp');
    expect(hanOrderFor(null, '한국어')[0]).toBe('kr');
    expect(hanOrderFor(null, '王小明')[0]).toBe('sc');
    expect(fontChainFor('en').map((f) => f.key)).toEqual(['latin', 'sc', 'tc', 'jp', 'kr']);
  });

  it('keeps WinAnsi text on the standard face and sends only the rest to Noto Sans', () => {
    const chain = fontChainFor('pl');
    expect(splitFontRuns('Łukasz Kowalczyk', chain)).toEqual([
      { text: 'Ł', face: 'latin' },
      { text: 'ukasz Kowalczyk', face: 'std' },
    ]);
    expect(splitFontRuns('Café', chain)).toEqual([{ text: 'Café', face: 'std' }]);
  });

  it.each([
    ['Polish, Czech, Turkish, Hungarian, Romanian, Vietnamese', 'pl', 'Ł ő č ž ś ı ğ ș ệ ữ Ąę Ń', 'latin'],
    ['Greek and Cyrillic', 'el', 'Ελληνικά Кириллица', 'latin'],
    ['Korean', 'ko', '한국어 이력서', 'kr'],
    ['Japanese kana and kokuji', 'ja', '働 込 畑 です カタカナ', 'jp'],
  ])('%s: every character lands on a face that has its glyph', (_label, locale, sample, expected) => {
    const chain = fontChainFor(locale, sample);
    const runs = splitFontRuns(sample, chain);
    expect(runs.some((r) => r.face === expected)).toBe(true);
    for (const r of runs) {
      if (r.face === 'std') continue;
      const face = chain.find((f) => f.key === r.face)!;
      for (const ch of r.text) expect(faceHasGlyph(face, ch.codePointAt(0)!), `${ch} in ${face.family}`).toBe(true);
    }
  });

  it('renders a Polish name and a Korean line with no missing glyphs', async () => {
    const md = '# Łukasz Kowalczyk\n\nKraków · łukasz@example.com\n\n## Doświadczenie\n\n**Firma Zażółć** — Inżynier\n- 한국어 이력서 문장입니다\n- Ελληνικά · Кириллица · Tiếng Việt\n';
    const buf = await renderResumePdf(md);
    const fonts = baseFonts(buf);
    expect(fonts.some((f) => f.includes('NotoSans-Bold'))).toBe(true);
    expect(fonts.some((f) => f.includes('NotoSans-Regular'))).toBe(true);
    expect(fonts.some((f) => f.includes('NotoSansKR-Regular'))).toBe(true);
    expect(latin1(buf)).toContain('/BaseFont /Helvetica');
    expect(notdefCount(buf)).toBe(0);
  });

  it('the box counter is real: a character no bundled face has shows as a box (not dropped)', async () => {
    const buf = await renderResumePdf('# Ada 😀 王\n\n- x\n');
    expect(notdefCount(buf)).toBe(1);
  });

  it('renders a Japanese resume on Noto Sans JP with no missing glyphs', async () => {
    const md = '# 山田 太郎\n\n## 職務経歴\n\n- 働き方改革の込み入った案件を担当\n- 畑違いの分野でも成果\n';
    const buf = await renderResumePdf(md, { locale: 'ja' });
    expect(baseFonts(buf).some((f) => f.includes('NotoSansJP'))).toBe(true);
    expect(notdefCount(buf)).toBe(0);
  });
});

/** The text runs of a docx body, each wrapped in ><, so `>Title<` matches a whole run. */
const docxText = (docx: Buffer) => (zipEntry(docx, 'word/document.xml') ?? '').replace(/<w:t[^>]*>/g, '>').replace(/<\/w:t>/g, '<');

describe('mixed-font lines (QA: a project title drawn under its first bullet)', () => {
  it('a line that starts in a CJK face and ends in Helvetica is as tall as one that ends in the CJK face', async () => {
    const { default: PDFDocument } = await import('pdfkit');
    const chain = X.fontChainFor('zh', '校园');
    const advance = (text: string) => {
      const doc = new PDFDocument({ size: [612, 792], margin: 40 });
      const { draw, measure } = X.createRunDrawer(doc, { chain, widthFrom: (x: number) => 612 - x - 40 });
      const y0 = 100;
      draw(text, 'bold', 10.5, 40, y0, { width: 532, lineGap: 2 });
      const moved = doc.y - y0;
      const measured = measure(text, 'bold', 10.5, 532, { lineGap: 2 });
      doc.end();
      return { moved, measured };
    };
    const cjkLast = advance('2025.03 – 2025.06 · 校园二手交易平台');
    const latinLast = advance('校园二手交易平台 · 2025.03 – 2025.06');
    const cjkOnly = advance('校园二手交易平台');
    const latinOnly = advance('2025.03 - 2025.06');
    // The CJK face is taller than Helvetica (this is what the bug needs).
    expect(cjkOnly.moved).toBeGreaterThan(latinOnly.moved + 1);
    // Before the fix `latinLast` advanced by Helvetica's line only.
    expect(latinLast.moved).toBeCloseTo(cjkOnly.moved, 3);
    expect(cjkLast.moved).toBeCloseTo(cjkOnly.moved, 3);
    // The guard reserves the same height the draw uses.
    expect(latinLast.measured).toBeCloseTo(cjkOnly.measured, 3);
  });
});

describe('section titles of a Chinese resume (QA: "Summary, Skills, Experience…" on a Chinese PDF)', () => {
  const UPLOADED_ZH = [
    '# 林知远',
    '',
    'lin@example.com · 138-0000-0000 · 杭州',
    '',
    '## Summary',
    '',
    '基础扎实，喜欢把问题量化后再优化；有两段后端实习，熟悉服务开发、测试与上线流程。',
    '',
    '## Skills',
    '',
    '**Technical:** MySQL · Redis · Kafka',
    '',
    '## Experience',
    '',
    '**后端开发实习生 — 星河数据科技有限公司** · 2026.06 – 2026.09',
    '- 使用 Go 和 gRPC 参与订单查询服务重构，将 P99 延迟从 420ms 降到 180ms。',
    '',
    '## Projects',
    '',
    '**校园二手交易平台** · 2025.03 – 2025.06',
    '- 负责后端架构与数据库设计。',
    '',
    '## Education',
    '',
    '**浙江大学 · 2023.09 - 2027.06** — 本科, 计算机科学与技术',
    '',
    '## Awards',
    '- 校级一等奖学金 (2024)',
    '',
    '## Languages',
    '',
    '英语 — CET-6',
  ].join('\n');

  it('prints the upload\u2019s default English titles in the resume\u2019s language', async () => {
    const doc = await X.renderResumeDocx(UPLOADED_ZH);
    const xml = docxText(doc);
    for (const title of ['个人总结', '专业技能', '实习经历', '项目经历', '教育背景', '获奖情况', '语言能力']) expect(xml, title).toContain(title);
    for (const title of ['Summary', 'Experience', 'Projects', 'Education', 'Awards']) expect(xml, title).not.toContain(`>${title}<`);
  });

  it('leaves an English resume, the user\u2019s own titles and an explicit choice alone', async () => {
    expect(docxText(await X.renderResumeDocx(EN))).toContain('Experience');
    const own = UPLOADED_ZH.replace('## Projects', '## Selected Work');
    expect(docxText(await X.renderResumeDocx(own))).toContain('Selected Work');
    const english = docxText(await X.renderResumeDocx(UPLOADED_ZH, { layout: { headingLanguage: 'en' } }));
    expect(english).toContain('Education');
    expect(english).not.toContain('教育背景');
    expect(X.bodyLanguage(X.parseResumeMarkdown(EN))).toBe('en');
    expect(X.bodyLanguage(X.parseResumeMarkdown(UPLOADED_ZH))).toBe('zh');
    expect(X.bodyLanguage(X.parseResumeMarkdown(ZH_TW))).toBe('zh-TW');
  });
});

describe('two-column paging', () => {
  it('keeps the sidebar in order across pages when it runs longer than page 1', async () => {
    const main = Array.from({ length: 40 }, (_, i) => `- Main ${i} ` + 'long words that wrap around the column several times '.repeat(3)).join('\n');
    const side = Array.from({ length: 18 }, (_, i) => `- SIDE${String(i).padStart(2, '0')} ` + 'skill text that is long enough to wrap '.repeat(4)).join('\n');
    const buf = await renderResumePdf(`# Ada\n\n## Experience\n\n${main}\n\n## Skills\n\n${side}\n`, { layout: { template: 'two_column' } });
    const pages = pageTexts(buf);
    const perPage = pages.map((t) => [...t.matchAll(/SIDE(\d\d)/g)].map((m) => Number(m[1])));
    expect(perPage.flat()).toEqual(Array.from({ length: 18 }, (_, i) => i));
    // Sidebar pages are contiguous from page 1: no empty page between two that hold sidebar items.
    const used = perPage.map((p) => p.length > 0);
    expect(used.indexOf(false) === -1 || used.slice(used.indexOf(false)).every((u) => !u)).toBe(true);
    expect(used[0]).toBe(true);
  });
});

describe('AI marks (CN-E-07, WP-13)', () => {
  const label = implicitLabelMetadata({ contentId: 'GA-0123456789abcdef01234567', provider: 'llm', brand: 'goapply', generatedAt: new Date('2026-10-10T00:00:00Z') });

  it('writes the implicit label into the PDF Info dictionary and XMP', async () => {
    const pdf = latin1(await renderResumePdf(ZH, { aiLabel: label }));
    for (const key of ['AIGC', 'AIGenerated', 'DigitalSourceType', 'AIContentID', 'AIProducer', 'AIProvider', 'AIGeneratedAt']) {
      expect(pdf).toContain(`/${key}`);
    }
    expect(pdf).toContain('GA-0123456789abcdef01234567');
    expect(pdf).toContain('Iptc4xmpExt:DigitalSourceType');
  });

  it('prints the explicit footer only when asked', async () => {
    const footer = '本文件部分内容由人工智能辅助生成，请核对后使用。';
    const withFooter = await renderResumePdf(ZH, { aiLabel: label, footerLine: footer });
    const without = await renderResumePdf(ZH, { aiLabel: label });
    // The footer adds glyphs to the embedded subset, so the files differ in size.
    expect(withFooter.length).toBeGreaterThan(without.length);
  });

  it('writes the implicit label into DOCX custom properties and the footer into the footer part', async () => {
    const docx = await renderResumeDocx(ZH, { aiLabel: label, footerLine: 'AI line' });
    const custom = zipEntry(docx, 'docProps/custom.xml');
    expect(custom).toContain('AIContentID');
    expect(custom).toContain('GA-0123456789abcdef01234567');
    const footer = zipEntry(docx, 'word/footer1.xml');
    expect(footer).toContain('AI line');
  });

  it('writes no AI marks when no label is passed', async () => {
    expect(latin1(await renderResumePdf(EN))).not.toContain('/AIContentID');
    expect(zipEntry(await renderResumeDocx(EN), 'docProps/custom.xml') ?? '').not.toContain('AIContentID');
  });
});

describe('DOCX author (QA: <dc:creator>Un-named</dc:creator>)', () => {
  it('is the candidate\u2019s name, never the library default', async () => {
    const core = zipEntry(await renderResumeDocx(EN), 'docProps/core.xml')!;
    expect(core).toContain('<dc:creator>Ada Lovelace</dc:creator>');
    expect(core).not.toContain('Un-named');
    // A resume with no name line: a blank author.
    const noName = zipEntry(await renderResumeDocx('## Experience\n- Built things\n'), 'docProps/core.xml')!;
    expect(noName).not.toContain('Un-named');
    expect(/<dc:creator>([^<]*)<\/dc:creator>/.exec(noName)?.[1]?.trim() ?? '').toBe('');
  });
});

describe('renderResumeDocx', () => {
  it('sets the page size and keeps every section', async () => {
    const docx = await renderResumeDocx(EN, { layout: { page: 'a4', template: 'two_column' } });
    const body = zipEntry(docx, 'word/document.xml')!;
    expect(body).toContain('w:w="11906"');
    expect(body).toContain('Experience');
    expect(body).toContain('Skills');
    // Two-column exports to Word as one column with the sidebar sections last.
    expect(body.indexOf('Experience')).toBeLessThan(body.indexOf('Skills'));
  });
});
