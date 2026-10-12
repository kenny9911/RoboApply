// @vitest-environment node
//
// WP-65 layout pieces: the layout merge, the fit-to-page search (pure), and the
// export renderer's new placements — personal details and a device photo
// placed after any model call, zh/en section titles, education order, bullet
// marks, justify, skills on one line, the campus template.

import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import {
  bulletMarkOf,
  countResumePages,
  fitPhotoBox,
  headingKeyOf,
  personalLine,
  photoPixelSize,
  photoTypeOf,
  renderResumeDocx,
  renderResumePdf,
  resolveLayout,
  translateHeading,
  withExportPhoto,
  RESUME_TEMPLATE_KEYS,
} from '../../../roboapply/v2/lib/resumeExport.js';
import { decodeExportPhoto, MAX_EXPORT_PHOTO_BYTES } from '../../../roboapply/v2/routes/resumes.js';
import { compressAt, FIT_FLOORS, fitToPage } from './fitToPage.js';
import { mergeLayout } from './merge.js';

/** A valid 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

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
    i = start + Math.max(compSize, 1);
  }
  return null;
}
const zipNames = (buf: Buffer) => [...buf.toString('latin1').matchAll(/PK\x03\x04[\s\S]{26}/g)].length;
const docText = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('\n');

const CN = `# 李同学
*li.test@example.test · 13800000000 · 上海*

## 求职意向

期望职位：数据分析实习生

## 实习经历

### 示例科技 · 数据分析实习生 · 2025.07 – 2025.09
- 整理销售数据并制作周报

## 教育背景

### 本科 统计学 · 示例大学 · 2022.09 – 2026.06

## 技能证书

- CET-6（560）
`;

const EN = `# Sam Rivera
*Analyst · sam@example.test*

## Experience

### Acme · Analyst · 2023 – 2024
- Built dashboards

## Education

### BS Economics · State University · 2020 – 2024

## Skills

- SQL
- Excel
- Tableau
`;

describe('mergeLayout', () => {
  it('merges sizes / spacing / personal field by field, replaces the rest, drops unknown keys', () => {
    const prev = { template: 'standard', sizes: { body: 10 }, personal: { nativePlace: 'A' }, junk: 1 };
    const out = mergeLayout(prev, { sizes: { name: 20 }, personal: { politicalStatus: 'B' }, photo: true, headingLanguage: 'en' });
    expect(out).toEqual({ template: 'standard', sizes: { body: 10, name: 20 }, personal: { nativePlace: 'A', politicalStatus: 'B' }, photo: true, headingLanguage: 'en' });
  });

  it('null removes a key; an empty string clears one personal field', () => {
    const prev = { template: 'campus', personal: { nativePlace: 'A', politicalStatus: 'B' } };
    expect(mergeLayout(prev, { personal: null })).toEqual({ template: 'campus' });
    expect(mergeLayout(prev, { personal: { nativePlace: '' } })).toEqual({ template: 'campus', personal: { politicalStatus: 'B' } });
    expect(mergeLayout(null, {})).toEqual({});
  });
});

describe('fit to page (pure search)', () => {
  const current = { sizes: { name: 22, section: 12.5, sub: 10.8, body: 9.8 }, spacing: { section: 10, entry: 5, line: 2, marginX: 54, marginY: 54 } };

  it('compresses spacing first, then margins, then sizes, down to the floors', () => {
    const early = compressAt(current, 0.3);
    expect(early.spacing.section).toBeLessThan(current.spacing.section);
    expect(early.spacing.marginX).toBe(current.spacing.marginX);
    expect(early.sizes).toEqual(current.sizes);
    const mid = compressAt(current, 0.6);
    expect(mid.spacing.marginX).toBeLessThan(current.spacing.marginX);
    expect(compressAt(current, 1)).toEqual({ sizes: FIT_FLOORS.sizes, spacing: FIT_FLOORS.spacing });
    expect(compressAt(current, 0)).toEqual(current);
  });

  it('never raises a value that is already below its floor', () => {
    const tiny = { sizes: { ...current.sizes, body: 8 }, spacing: { ...current.spacing, marginX: 28 } };
    const out = compressAt(tiny, 1);
    expect(out.sizes.body).toBe(8);
    expect(out.spacing.marginX).toBe(28);
  });

  it('finds the least compression that fits; already_fits and too_long change nothing', async () => {
    // Pages fall to 1 once the body size drops below 9.3.
    const count = vi.fn(async (v: typeof current) => (v.sizes.body < 9.3 ? 1 : 2));
    const fitted = await fitToPage({ current, target: 1, countPages: count });
    expect(fitted.status).toBe('fitted');
    expect(fitted.applied!.sizes.body).toBeLessThan(9.3);
    expect(fitted.applied!.sizes.body).toBeGreaterThan(FIT_FLOORS.sizes.body);
    expect(fitted.previous).toEqual(current);
    expect(count.mock.calls.length).toBeLessThanOrEqual(8);
    expect((await fitToPage({ current, target: 1, countPages: async () => 1 })).status).toBe('already_fits');
    const tooLong = await fitToPage({ current, target: 1, countPages: async () => 3 });
    expect(tooLong.status).toBe('too_long');
    expect(tooLong.applied).toBeNull();
    expect((await fitToPage({ current, target: 2, countPages: async (v) => (v.spacing.section < 8 ? 2 : 3) })).pages.target).toBe(2);
  });
});

describe('export renderer (WP-65 placements)', () => {
  it('knows the campus template and reads the new layout keys', () => {
    expect(RESUME_TEMPLATE_KEYS).toContain('campus');
    const l = resolveLayout({ template: 'campus', justify: true, bullet: 'hollow', eduOrder: 'before_experience', skillsLayout: 'inline', headingLanguage: 'en', personal: { nativePlace: ' 江苏 南京 ', other: 'x' }, photo: false });
    expect(l).toMatchObject({ template: 'campus', justify: true, bullet: '◦', eduOrder: 'before_experience', skillsLayout: 'inline', headingLanguage: 'en', personal: { nativePlace: '江苏 南京' }, photo: false });
    expect(resolveLayout({}).photo).toBe(true);
    expect(resolveLayout({}).headingLanguage).toBe('as_written');
    expect(bulletMarkOf('dash')).toBe('–');
    expect(bulletMarkOf('★')).toBe('★');
    expect(bulletMarkOf('abc')).toBe('•');
  });

  it('translates known section titles both ways and leaves unknown ones alone', () => {
    expect(translateHeading('实习经历', 'en')).toBe('Internships');
    expect(translateHeading('技能证书', 'en')).toBe('Skills & certificates');
    expect(translateHeading('Education', 'zh')).toBe('教育背景');
    expect(translateHeading('Experience', 'zh-TW')).toBe('工作經歷');
    expect(translateHeading('Volunteering', 'zh')).toBe('Volunteering');
    expect(translateHeading('实习经历', 'as_written')).toBe('实习经历');
    expect(headingKeyOf('Work Experience')).toBe('experience');
    expect(headingKeyOf('Internship Experience')).toBe('internship');
  });

  it('prints the personal details line only from what the user entered', () => {
    expect(personalLine({ nativePlace: '浙江绍兴', politicalStatus: '共青团员' }, 'zh')).toBe('籍贯：浙江绍兴 ｜ 政治面貌：共青团员');
    expect(personalLine({ politicalStatus: 'League member' }, 'en')).toBe('Political status: League member');
    expect(personalLine(null, 'zh')).toBeNull();
  });

  it('DOCX: personal line in the header, English titles, education first, dash bullets, justified', async () => {
    const buf = await renderResumeDocx(CN, {
      layout: { template: 'campus', personal: { nativePlace: '浙江绍兴' }, headingLanguage: 'en', eduOrder: 'before_experience', bullet: 'dash', justify: true },
      locale: 'zh',
    });
    const xml = zipEntry(buf, 'word/document.xml')!;
    const text = docText(xml);
    expect(text).toContain('Native place: 浙江绍兴');
    expect(text.indexOf('Education')).toBeLessThan(text.indexOf('Internships'));
    expect(text).toContain('Job objective');
    expect(text).toContain('–  整理销售数据并制作周报');
    expect(xml).toContain('w:val="both"');
    // The resume text itself is unchanged: user content stays as written.
    expect(text).toContain('期望职位：数据分析实习生');
  });

  it('DOCX: Chinese labels by default for a Chinese resume; no line without details', async () => {
    const zh = docText(zipEntry(await renderResumeDocx(CN, { layout: { personal: { politicalStatus: '群众' } }, locale: 'zh' }), 'word/document.xml')!);
    expect(zh).toContain('政治面貌：群众');
    const none = docText(zipEntry(await renderResumeDocx(CN, { layout: {} }), 'word/document.xml')!);
    expect(none).not.toMatch(/籍贯|政治面貌/);
  });

  it('skills on one line when skillsLayout is inline', async () => {
    const text = docText(zipEntry(await renderResumeDocx(EN, { layout: { skillsLayout: 'inline' } }), 'word/document.xml')!);
    expect(text).toContain('SQL · Excel · Tableau');
  });

  it('places a photo carried by the request (PDF and DOCX), never when the layout turns it off', async () => {
    const withPhoto = await withExportPhoto(PNG, () => renderResumePdf(CN, { layout: { template: 'campus' }, locale: 'zh' }));
    expect(withPhoto.toString('latin1')).toMatch(/\/Subtype \/Image/);
    const off = await withExportPhoto(PNG, () => renderResumePdf(CN, { layout: { photo: false }, locale: 'zh' }));
    expect(off.toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    const none = await renderResumePdf(CN, { layout: {}, locale: 'zh' });
    expect(none.toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    const docx = await renderResumeDocx(CN, { layout: {}, photo: PNG });
    expect(docx.toString('latin1')).toContain('word/media/');
    expect(zipNames(docx)).toBeGreaterThan(zipNames(await renderResumeDocx(CN, { layout: {} })));
  });

  it('DOCX keeps the photo aspect ratio inside the 64×90 box (no stretching)', async () => {
    expect(photoPixelSize(PNG)).toEqual({ width: 1, height: 1 });
    // A JPEG header: SOI, APP0 (len 16), SOF0 with height 400 and width 300.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x01, 0x2c, 0x03]),
      Buffer.alloc(12),
    ]);
    expect(photoPixelSize(jpeg)).toEqual({ width: 300, height: 400 });
    expect(photoPixelSize(Buffer.from('not an image'))).toBeNull();
    expect(fitPhotoBox(PNG)).toEqual({ width: 64, height: 64 });
    const portrait = fitPhotoBox(jpeg);
    expect(portrait.width).toBeCloseTo(64);
    expect(portrait.height).toBeCloseTo(85.33, 1);
    expect(fitPhotoBox(Buffer.from('x'))).toEqual({ width: 64, height: 90 });

    const docx = await renderResumeDocx(CN, { layout: {}, photo: PNG });
    const xml = zipEntry(docx, 'word/document.xml') ?? '';
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml);
    expect(extent).not.toBeNull();
    expect(extent![1]).toBe(extent![2]);
  });

  it('counts pages for fit-to-page', async () => {
    expect(await countResumePages(EN, { layout: {} })).toBe(1);
  });
});

describe('export photo upload (POST /:id/export)', () => {
  it('accepts a JPEG/PNG data URL within the size cap and nothing else', () => {
    expect(decodeExportPhoto(undefined)).toBeNull();
    expect(decodeExportPhoto('')).toBeNull();
    expect(photoTypeOf(decodeExportPhoto(`data:image/png;base64,${PNG.toString('base64')}`))).toBe('png');
    expect(() => decodeExportPhoto('data:image/gif;base64,R0lGOD')).toThrow('invalid_photo');
    expect(() => decodeExportPhoto(`data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}`)).toThrow('invalid_photo');
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_EXPORT_PHOTO_BYTES)]);
    expect(() => decodeExportPhoto(`data:image/png;base64,${big.toString('base64')}`)).toThrow('invalid_photo');
    expect(() => decodeExportPhoto(42)).toThrow('invalid_photo');
  });
});
