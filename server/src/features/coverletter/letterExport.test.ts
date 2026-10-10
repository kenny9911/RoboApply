// @vitest-environment node
//
// Cover-letter export fonts (INT-10; wave3 WP-93 #20). Letters share the
// resume exporter's per-run font chain: each run of text prints in the first
// face that has its glyphs, in the order of the letter's locale. Korean
// letters used to have no KR face at all (the SC/TC pair has no Hangul, so
// they were refused or printed as boxes); zh-TW keeps the Traditional face.

import { describe, expect, it } from 'vitest';

import { bundledFace, faceHasGlyph } from '../../roboapply/v2/lib/resumeExport.js';
import {
  PdfFontUnavailableError,
  cjkFontsFor,
  letterFacesUsed,
  letterFontChain,
  letterFontRuns,
  letterParagraphs,
  pdfFontsAvailable,
  renderLetterDocx,
  renderLetterPdf,
  type LetterExportInput,
} from './letterExport.js';

const LABEL = { pdfInfo: { AIContentID: 'RA-0123456789abcdef01234567' }, docxCustomProperties: { AIContentID: 'RA-0123456789abcdef01234567' }, xmp: '<rdf:Description/>' };
const input = (body: string, locale: string, footerLine: string | null = null): LetterExportInput => ({ body, title: 'Cover letter', locale, label: LABEL, footerLine });
const latin1 = (b: Buffer) => b.toString('latin1');
const cp = (ch: string) => ch.codePointAt(0)!;

const KO = '채용 담당자님께\n\n저는 Acme Pay에서 Postgres 클러스터 7개를 AWS Aurora로 이전했습니다.\n\n감사합니다.';
const ZH_TW = '敬愛的招募經理：\n\n我在 Acme Pay 負責將 7 個 Postgres 叢集遷移到 AWS Aurora，並優化資料庫與體驗。\n\n敬祝 順心';
const ZH = '尊敬的招聘经理：\n\n我在 Acme Pay 负责把 7 个 Postgres 集群迁移到 AWS Aurora。\n\n此致\n敬礼';
const EN = 'Dear hiring manager,\n\nI moved 7 Postgres clusters to AWS Aurora at Acme Pay.\n\nSincerely,\nSam';

/** The faces the run splitter picked, for the non-Latin runs of a text. */
const faces = (text: string, locale: string) => [...new Set(letterFontRuns(text, locale).filter((r) => r.face !== 'std').map((r) => r.face))];

describe('font chosen per run', () => {
  it('Latin text needs no bundled face in any locale', () => {
    for (const locale of ['en', 'ko', 'zh-TW', 'zh']) {
      expect(letterFontChain([EN], locale)).toEqual([]);
      expect(letterFontRuns(EN, locale)).toEqual([{ text: EN, face: 'std' }]);
      expect(letterFacesUsed([EN], locale)).toEqual([]);
    }
  });

  it('ko: Hangul prints in the KR face; Latin words and digits stay in the standard face', () => {
    expect(bundledFace('kr')).not.toBeNull();
    const runs = letterFontRuns('저는 Acme Pay에서 Postgres 클러스터 7개를 이전했습니다.', 'ko');
    expect(faces(KO, 'ko')).toEqual(['kr']);
    expect(runs.find((r) => r.text.includes('저는'))!.face).toBe('kr');
    expect(runs.find((r) => r.text.includes('Acme Pay'))!.face).toBe('std');
    expect(runs.find((r) => r.text.includes('Postgres'))!.face).toBe('std');
    // Every Hangul syllable lands in a KR run, never in a Chinese face.
    for (const run of runs) if (/[가-힣]/.test(run.text)) expect(run.face).toBe('kr');
    // The old letter exporter knew only the SC/TC pair, neither of which draws Hangul.
    expect(faceHasGlyph(bundledFace('sc')!, cp('채'))).toBe(false);
    expect(faceHasGlyph(bundledFace('kr')!, cp('채'))).toBe(true);
  });

  it('zh-TW: Han text prints in the Traditional face, including characters the Simplified face lacks', () => {
    const tc = bundledFace('tc')!;
    expect(tc).not.toBeNull();
    expect(['NotoSansTC', 'HanSansTC']).toContain(tc.family);
    expect(faces(ZH_TW, 'zh-TW')).toEqual(['tc']);
    // 體 and 叢 are Traditional-only: the SC face (GB2312) has no glyph for them.
    for (const ch of ['體', '叢']) {
      expect(faceHasGlyph(bundledFace('sc')!, cp(ch))).toBe(false);
      expect(letterFontRuns(ch, 'zh-TW')[0]!.face).toBe('tc');
    }
    // Characters both faces have still go to TC first in a zh-TW letter.
    expect(letterFontRuns('我在', 'zh-TW')[0]!.face).toBe('tc');
  });

  it('zh: Han text prints in the Simplified face; a Traditional-only character falls back to TC, not a box', () => {
    expect(faces(ZH, 'zh')).toEqual(['sc']);
    expect(letterFontRuns('我在', 'zh')[0]!.face).toBe('sc');
    const mixed = letterFontRuns('数据與體驗', 'zh');
    expect(mixed.find((r) => r.text.includes('数据'))!.face).toBe('sc');
    expect(mixed.find((r) => r.text.includes('體'))!.face).toBe('tc');
  });

  it('a Korean letter with a Chinese company name uses KR, then a Han face for what KR lacks', () => {
    const used = letterFacesUsed(['저는 北京字节跳动 에서 일했습니다.'], 'ko');
    expect(used[0]).toBe('kr');
    for (const run of letterFontRuns('저는 北京字节跳动 에서', 'ko')) {
      if (/[가-힣]/.test(run.text)) expect(run.face).toBe('kr');
    }
  });

  it('cjkFontsFor names the primary face of the locale', () => {
    expect(cjkFontsFor('ko')!.regular).toContain('NotoSansKR');
    expect(cjkFontsFor('zh')!.regular).toContain('NotoSansSC');
    expect(cjkFontsFor('zh-TW')!.regular).toMatch(/NotoSansTC|HanSansTC/);
    expect(cjkFontsFor('ja')!.regular).toContain('NotoSansJP');
  });
});

describe('renderLetterPdf embeds the face each locale needs', () => {
  it('ko: a real PDF with Noto Sans KR embedded, and no Chinese face', async () => {
    expect(pdfFontsAvailable([KO], 'ko')).toBe(true);
    const pdf = latin1(await renderLetterPdf(input(KO, 'ko')));
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('NotoSansKR');
    expect(pdf).not.toContain('NotoSansSC');
    expect(pdf).not.toMatch(/HanSansTC|NotoSansTC/);
    expect(pdf).toContain('/AIContentID');
  });

  it('zh-TW: the Traditional face is embedded, not the Simplified one', async () => {
    const pdf = latin1(await renderLetterPdf(input(ZH_TW, 'zh-TW')));
    expect(pdf).toMatch(/HanSansTC|NotoSansTC/);
    expect(pdf).not.toContain('NotoSansSC');
    expect(pdf).not.toContain('NotoSansKR');
  });

  it('zh: Noto Sans SC is embedded; the footer line prints in it too', async () => {
    const pdf = latin1(await renderLetterPdf(input(ZH, 'zh', '本内容由人工智能生成')));
    expect(pdf).toContain('NotoSansSC');
    expect(pdf).not.toMatch(/HanSansTC|NotoSansTC/);
    expect(pdf).not.toContain('NotoSansKR');
  });

  it('en: only the PDF standard face, nothing embedded', async () => {
    const pdf = latin1(await renderLetterPdf(input(EN, 'en')));
    expect(pdf).toContain('Helvetica');
    expect(pdf).not.toMatch(/NotoSans|HanSans/);
  });

  it('an English-locale letter that names a Korean company still prints the Hangul (the face follows the text)', async () => {
    const body = `${EN}\n\nI worked with 삼성전자 for two years.`;
    expect(pdfFontsAvailable([body], 'en')).toBe(true);
    expect(latin1(await renderLetterPdf(input(body, 'en')))).toContain('NotoSansKR');
  });

  it('an empty body still makes a valid PDF', async () => {
    expect(latin1(await renderLetterPdf(input('', 'en'))).startsWith('%PDF-')).toBe(true);
    expect(letterParagraphs('')).toEqual([]);
  });

  it('a rare character no face has does not block the PDF', async () => {
    const body = `${EN} \u{1F600}`;
    expect(pdfFontsAvailable([body], 'en')).toBe(true);
    expect(latin1(await renderLetterPdf(input(body, 'en'))).startsWith('%PDF-')).toBe(true);
  });

  it('PdfFontUnavailableError is what a missing script face raises (kept for the service guard)', () => {
    expect(new PdfFontUnavailableError().message).toBe('pdf_font_unavailable');
  });

  it('Word export is unaffected', async () => {
    const docx = await renderLetterDocx(input(KO, 'ko'));
    expect(docx.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('the Word file never names the author "Un-named" (QA: docProps/core.xml)', async () => {
    const zlib = await import('node:zlib');
    /** docProps/core.xml of a docx (central directory walk; deflate or stored). */
    const coreXml = (buf: Buffer): string => {
      let i = 0;
      while ((i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i)) !== -1) {
        const method = buf.readUInt16LE(i + 8);
        const compSize = buf.readUInt32LE(i + 18);
        const nameLen = buf.readUInt16LE(i + 26);
        const extraLen = buf.readUInt16LE(i + 28);
        const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
        const start = i + 30 + nameLen + extraLen;
        if (name === 'docProps/core.xml') {
          const data = buf.subarray(start, start + compSize);
          return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
        }
        i = start + compSize;
      }
      return '';
    };
    const anonymous = coreXml(await renderLetterDocx(input(EN, 'en')));
    expect(anonymous).toContain('dc:creator');
    expect(anonymous).not.toContain('Un-named');
    const named = coreXml(await renderLetterDocx({ ...input(EN, 'en'), author: 'Sam Lee' }));
    expect(named).toContain('<dc:creator>Sam Lee</dc:creator>');
  });
});
