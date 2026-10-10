// @vitest-environment node
//
// Receipt fonts (INT-10; wave3 WP-93 #21). The receipt draws with the resume
// exporter's per-run font chain. It used to read Noto Sans SC only (GB2312
// coverage), so Traditional-only characters printed as boxes.

import { describe, expect, it } from 'vitest';

import { bundledFace, faceHasGlyph, splitFontRuns } from '../v2/lib/resumeExport.js';
import { receiptFacesUsed, receiptFontChain, renderAlipayReceiptPdf, type ReceiptInput } from './invoiceReceipt.js';

const latin1 = (b: Buffer) => b.toString('latin1');
const cp = (ch: string) => ch.codePointAt(0)!;

const receipt = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
  orderId: 'ord_1',
  outTradeNo: 'GA20261010000001',
  brandName: 'GoApply',
  planLabel: 'Pro monthly',
  subject: 'GoApply 会员月卡',
  amountMinor: 3900,
  currency: 'CNY',
  paidAt: new Date('2026-10-10T08:00:00Z'),
  customerName: '张三',
  customerEmail: 'zhang@example.test',
  ...over,
});

/** Traditional-only characters: not in GB2312, so the Simplified face has no glyph for them. */
const TRADITIONAL_ONLY = ['體', '灣', '叢', '龍'];

describe('receipt font chain', () => {
  it('the premise: the Simplified face alone cannot draw these Traditional characters', () => {
    const sc = bundledFace('sc')!;
    const tc = bundledFace('tc')!;
    expect(sc).not.toBeNull();
    expect(tc).not.toBeNull();
    for (const ch of TRADITIONAL_ONLY) {
      expect(faceHasGlyph(sc, cp(ch))).toBe(false);
      expect(faceHasGlyph(tc, cp(ch))).toBe(true);
    }
  });

  it('Traditional characters on a receipt go to the Traditional face; Simplified text stays in SC', () => {
    const input = receipt({ customerName: '陳體龍', subject: 'GoApply 會員月卡（臺灣）' });
    const chain = receiptFontChain(input);
    expect(chain.map((f) => f.key)).toEqual(['latin', 'sc', 'tc', 'jp', 'kr'].filter((k) => bundledFace(k as 'sc') !== null));
    for (const ch of TRADITIONAL_ONLY) expect(splitFontRuns(ch, chain)[0]!.face).toBe('tc');
    // 会员月卡 (Simplified) is drawn by SC.
    expect(splitFontRuns('会员月卡', chain)[0]!.face).toBe('sc');
    // No character of the receipt is left without a face.
    const drawable = (ch: string) => chain.some((f) => faceHasGlyph(f, cp(ch)));
    for (const ch of '陳體龍會員月卡臺灣') expect(drawable(ch)).toBe(true);
    expect(receiptFacesUsed(input)).toEqual(expect.arrayContaining(['sc', 'tc']));
  });

  it('renders a PDF that embeds the Traditional face next to the Simplified one', async () => {
    const pdf = latin1(await renderAlipayReceiptPdf(receipt({ customerName: '陳體龍', subject: 'GoApply 會員月卡（臺灣）' })));
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toMatch(/HanSansTC|NotoSansTC/);
    expect(pdf).toContain('NotoSansSC'); // the default payment method line "支付宝"
  });

  it('a Simplified-only receipt embeds SC and no Traditional face', async () => {
    const input = receipt();
    expect(receiptFacesUsed(input)).toEqual(['sc']);
    const pdf = latin1(await renderAlipayReceiptPdf(input));
    expect(pdf).toContain('NotoSansSC');
    expect(pdf).not.toMatch(/HanSansTC|NotoSansTC/);
  });

  it('locale zh-TW puts the Traditional face first for characters both faces have', () => {
    const input = receipt({ locale: 'zh-TW', customerName: '王小明', subject: '月卡', paymentMethod: 'WeChat Pay' });
    expect(receiptFacesUsed(input)).toEqual(['tc']);
  });

  it('a Korean name prints in the KR face', async () => {
    const input = receipt({ customerName: '김민준', paymentMethod: 'WeChat Pay', subject: 'Pro monthly' });
    expect(receiptFacesUsed(input)).toEqual(['kr']);
    expect(latin1(await renderAlipayReceiptPdf(input))).toContain('NotoSansKR');
  });

  it('a Latin-only receipt embeds nothing', async () => {
    const input = receipt({ brandName: 'RoboApply', customerName: 'Ada Lovelace', subject: 'Pro monthly', paymentMethod: 'WeChat Pay' });
    expect(receiptFontChain(input)).toEqual([]);
    const pdf = latin1(await renderAlipayReceiptPdf(input));
    expect(pdf).toContain('Helvetica');
    expect(pdf).not.toMatch(/NotoSans|HanSans/);
  });

  it('prints the collecting entity only when one is given', async () => {
    const withEntity = receiptFacesUsed(receipt({ collectedBy: '某某資訊股份有限公司' }));
    expect(withEntity).toEqual(expect.arrayContaining(['tc']));
    expect(latin1(await renderAlipayReceiptPdf(receipt({ collectedBy: null }))).startsWith('%PDF-')).toBe(true);
  });
});
