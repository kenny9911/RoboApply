// server/src/roboapply/lib/invoiceReceipt.ts
//
// Generates a brand-aware PDF receipt for a CN-rail order (Alipay today, WeChat
// Pay from WP-62). Stripe provides its own hosted invoice PDF; the GoHire
// payment worker does not, so we render our own.
//
// Fonts (INT-10; wave3 WP-93 #21): the resume exporter's per-run font chain
// (roboapply/v2/lib/resumeExport.ts `createRunDrawer`). Every piece of text is
// drawn run by run in the first face that has its glyphs: the PDF standard
// face for Latin text, then the bundled faces in the receipt locale's order.
// The receipt used to read Noto Sans SC only, which covers GB2312: a
// Traditional-only character in a name or a plan title (體, 叢, 灣 …) printed
// as a box. It now falls to the Traditional face, Hangul to the KR face.
//
// TASK_PLAN.md WP-21a: the receipt carries the brand that sold the plan and
// names the entity that actually collected the money
// (`CN_PAYMENT_COLLECTING_ENTITY`, ARCHITECTURE.md §7.4) when configured —
// never an invented one.

import PDFDocument from 'pdfkit';
import { createRunDrawer, fontChainForText, splitFontRuns, type FaceKey, type FontFaces } from '../v2/lib/resumeExport.js';

/** Receipts are a CN-rail document: Simplified first, then Traditional, Japanese, Korean. */
export const RECEIPT_DEFAULT_LOCALE = 'zh';

export interface ReceiptInput {
  orderId: string;
  outTradeNo: string;
  /** The brand that sold the plan ('RoboApply' | 'GoApply'). */
  brandName: string;
  planLabel: string;
  subject: string; // e.g. 'GoApply 会员月卡'
  amountMinor: number; // fen
  currency: string; // 'CNY'
  paidAt: Date;
  customerName: string;
  customerEmail: string;
  /** 'Alipay (支付宝)' | 'WeChat Pay (微信支付)'. */
  paymentMethod?: string;
  /** The entity that collected the payment, from config; omitted when unset. */
  collectedBy?: string | null;
  /** Pass/pack wording for the footer. */
  footerNote?: string;
  /**
   * Locale that orders the Han/Hangul/kana faces (default `zh`: Simplified
   * first). `zh-TW` puts the Traditional face first.
   */
  locale?: string | null;
}

const DEFAULT_PAYMENT_METHOD = 'Alipay (支付宝)';

function defaultFooter(brandName: string): string {
  return `Thank you for using ${brandName}. This receipt confirms a one-time payment; it does not renew. Practice credits are granted on payment. For questions, contact support.`;
}

/** Every string the receipt prints (the font chain is chosen from all of it). */
export function receiptTexts(input: ReceiptInput): string[] {
  return [
    input.brandName,
    input.outTradeNo,
    input.customerName || input.customerEmail,
    input.customerEmail,
    input.paymentMethod ?? DEFAULT_PAYMENT_METHOD,
    input.collectedBy ?? '',
    input.subject,
    input.footerNote ?? defaultFooter(input.brandName),
  ];
}

/** The fallback chain this receipt needs (empty when the standard face draws all of it). */
export function receiptFontChain(input: ReceiptInput): FontFaces[] {
  return fontChainForText(input.locale ?? RECEIPT_DEFAULT_LOCALE, receiptTexts(input).join('\n'));
}

/** The bundled faces this receipt embeds, in the order its text first uses them. */
export function receiptFacesUsed(input: ReceiptInput): FaceKey[] {
  const chain = receiptFontChain(input);
  const used: FaceKey[] = [];
  if (chain.length === 0) return used;
  for (const text of receiptTexts(input)) {
    for (const run of splitFontRuns(text, chain)) if (run.face !== 'std' && !used.includes(run.face)) used.push(run.face);
  }
  return used;
}

function money(amountMinor: number, currency: string): string {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
  return `${symbol}${(amountMinor / 100).toFixed(2)} ${currency}`;
}

function receiptToBuffer(doc: InstanceType<typeof PDFDocument>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export async function renderAlipayReceiptPdf(input: ReceiptInput): Promise<Buffer> {
  const margin = 56;
  const doc = new PDFDocument({ size: 'A4', margin });
  const left = margin;
  const right = 539;
  const { draw } = createRunDrawer(doc, { chain: receiptFontChain(input), widthFrom: (x) => right - x });
  const accent = '#5b5bd6';

  // Header
  doc.fillColor(accent);
  draw(input.brandName, 'bold', 22, left, 56);
  doc.fillColor('#555');
  draw('Payment Receipt', 'reg', 11, left, 84);
  doc.moveTo(left, 110).lineTo(right, 110).strokeColor('#e5e7eb').stroke();

  // Meta block
  let y = 132;
  const row = (label: string, value: string) => {
    doc.fillColor('#888');
    draw(label, 'reg', 10, left, y);
    doc.fillColor('#111');
    draw(value, 'bold', 11, left + 160, y, { width: 323 });
    y += 26;
  };
  row('Receipt no.', input.outTradeNo);
  row('Date', input.paidAt.toISOString().slice(0, 10));
  row('Billed to', `${input.customerName || input.customerEmail}`);
  row('Email', input.customerEmail);
  row('Payment method', input.paymentMethod ?? DEFAULT_PAYMENT_METHOD);
  if (input.collectedBy) row('Collected by', input.collectedBy);
  row('Status', 'Paid');

  // Line item
  const amount = money(input.amountMinor, input.currency);
  y += 12;
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e7eb').stroke();
  y += 16;
  doc.fillColor('#888');
  draw('Description', 'bold', 11, left, y);
  draw('Amount', 'bold', 11, left + 360, y, { width: 123, align: 'right' });
  y += 22;
  doc.fillColor('#111');
  draw(input.subject, 'reg', 12, left, y, { width: 350 });
  draw(amount, 'reg', 12, left + 360, y, { width: 123, align: 'right' });
  y += 30;
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e7eb').stroke();
  y += 14;
  draw('Total', 'bold', 13, left, y);
  doc.fillColor(accent);
  draw(amount, 'bold', 13, left + 360, y, { width: 123, align: 'right' });

  // Footer
  doc.fillColor('#999');
  draw(input.footerNote ?? defaultFooter(input.brandName), 'reg', 9, left, 760, { width: 483 });

  return receiptToBuffer(doc);
}
