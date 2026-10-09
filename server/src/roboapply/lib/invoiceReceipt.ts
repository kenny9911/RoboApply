// backend/src/roboapply/lib/invoiceReceipt.ts
//
// Generates a brand-aware PDF receipt for a CN-rail order (Alipay today, WeChat
// Pay from WP-62). Stripe provides its own hosted invoice PDF; the GoHire
// payment worker does not, so we render our own. CJK-safe via the bundled
// Noto Sans SC faces (Chinese subjects render real glyphs, not tofu boxes).
//
// TASK_PLAN.md WP-21a: the receipt carries the brand that sold the plan and
// names the entity that actually collected the money
// (`CN_PAYMENT_COLLECTING_ENTITY`, ARCHITECTURE.md §7.4) when configured —
// never an invented one.

import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib/ is backend/src/roboapply/lib → up 3 to backend/, then assets/fonts.
const FONT_DIR = path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'NotoSansSC-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSansSC-Bold.ttf');
const HAS_FONTS = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);

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
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const reg = HAS_FONTS ? 'NotoSC' : 'Helvetica';
  const bold = HAS_FONTS ? 'NotoSC-Bold' : 'Helvetica-Bold';
  if (HAS_FONTS) {
    doc.registerFont('NotoSC', FONT_REGULAR);
    doc.registerFont('NotoSC-Bold', FONT_BOLD);
  }

  const left = 56;
  const accent = '#5b5bd6';

  // Header
  doc.font(bold).fontSize(22).fillColor(accent).text(input.brandName, left, 56);
  doc.font(reg).fontSize(11).fillColor('#555').text('Payment Receipt', left, 84);
  doc.moveTo(left, 110).lineTo(539, 110).strokeColor('#e5e7eb').stroke();

  // Meta block
  let y = 132;
  const row = (label: string, value: string) => {
    doc.font(reg).fontSize(10).fillColor('#888').text(label, left, y);
    doc.font(bold).fontSize(11).fillColor('#111').text(value, left + 160, y, { width: 323 });
    y += 26;
  };
  row('Receipt no.', input.outTradeNo);
  row('Date', input.paidAt.toISOString().slice(0, 10));
  row('Billed to', `${input.customerName || input.customerEmail}`);
  row('Email', input.customerEmail);
  row('Payment method', input.paymentMethod ?? 'Alipay (支付宝)');
  if (input.collectedBy) row('Collected by', input.collectedBy);
  row('Status', 'Paid');

  // Line item
  y += 12;
  doc.moveTo(left, y).lineTo(539, y).strokeColor('#e5e7eb').stroke();
  y += 16;
  doc.font(bold).fontSize(11).fillColor('#888').text('Description', left, y);
  doc.font(bold).fontSize(11).fillColor('#888').text('Amount', left + 360, y, { width: 123, align: 'right' });
  y += 22;
  doc.font(reg).fontSize(12).fillColor('#111').text(input.subject, left, y, { width: 350 });
  doc.font(reg).fontSize(12).fillColor('#111').text(money(input.amountMinor, input.currency), left + 360, y, { width: 123, align: 'right' });
  y += 30;
  doc.moveTo(left, y).lineTo(539, y).strokeColor('#e5e7eb').stroke();
  y += 14;
  doc.font(bold).fontSize(13).fillColor('#111').text('Total', left, y);
  doc.font(bold).fontSize(13).fillColor(accent).text(money(input.amountMinor, input.currency), left + 360, y, { width: 123, align: 'right' });

  // Footer
  doc.font(reg).fontSize(9).fillColor('#999').text(
    input.footerNote ?? `Thank you for using ${input.brandName}. This receipt confirms a one-time payment; it does not renew. Practice credits are granted on payment. For questions, contact support.`,
    left,
    760,
    { width: 483 },
  );

  return receiptToBuffer(doc);
}
