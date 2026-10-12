// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { detectScamSignals, mergeFraudFlags, splitSentences, toFraudFlags } from './scamSignals.js';
import { MAX_QUOTE_CHARS } from './schema.js';
import { INTL_POSTING } from './__tests__/fixtures.js';

function rules(text: string) {
  return detectScamSignals(text).map((s) => s.rule);
}

describe('intl scam signals', () => {
  it('flags fees, each with the sentence it rests on', () => {
    const text = 'Work from home data entry. A one-time training fee of $85 is due before your first shift. Apply at https://example.com/apply.';
    const signals = detectScamSignals(text);
    expect(signals).toEqual([{ rule: 'intl_fee_required', quote: 'A one-time training fee of $85 is due before your first shift.' }]);
    expect(text).toContain(signals[0]!.quote);
  });

  it('flags the buy-equipment-to-be-reimbursed pattern', () => {
    const signals = detectScamSignals('You will purchase your home office equipment from our vendor and be reimbursed by check. Email jobs@example.com.');
    expect(signals.map((s) => s.rule)).toEqual(['intl_fee_required']);
  });

  it('flags pay to apply (and does not double-flag it as a fee)', () => {
    const text = 'Please pay a $30 processing charge to be considered for the position. Send it to jobs@example.com.';
    expect(rules(text)).toEqual(['intl_pay_to_apply']);
    expect(rules('There is a $25 application fee. Apply on our site https://example.com.')).toEqual(['intl_pay_to_apply']);
  });

  it('flags messaging-app-only contact', () => {
    const text = 'Great pay for remote assistants. To apply, contact our hiring manager on Telegram @hr_desk for an interview.';
    const signals = detectScamSignals(text);
    expect(signals).toEqual([{ rule: 'intl_messaging_app_only', quote: 'To apply, contact our hiring manager on Telegram @hr_desk for an interview.' }]);
  });

  it('flags an explicit "only via WhatsApp" even when an email appears elsewhere', () => {
    expect(rules('Interviews are conducted only via WhatsApp. Questions: hr@example.com.')).toEqual(['intl_messaging_app_only']);
  });

  it('does not flag a messaging app when the posting also gives an email or web link', () => {
    expect(rules('Text us on WhatsApp or email careers@example.com to apply.')).toEqual([]);
    expect(rules('Message us on Telegram or apply at https://jobs.example.com/123.')).toEqual([]);
  });

  it('does not flag reassurances or product mentions', () => {
    expect(rules('We will never ask you to pay a fee at any stage of hiring.')).toEqual([]);
    expect(rules('There is no application fee.')).toEqual([]);
    expect(rules('Pay is sent by direct deposit every two weeks.')).toEqual([]);
    expect(rules('We cover the background check fee.')).toEqual([]);
    expect(rules('We pay for your certification fees after 90 days.')).toEqual([]);
    expect(rules('You will build WhatsApp and Telegram integrations for our chat product.')).toEqual([]);
    expect(rules('Experience with signal processing is a plus.')).toEqual([]);
    expect(rules(INTL_POSTING)).toEqual([]);
  });

  it('does not flag fees the employer pays, wherever the sentence says so (review fixtures)', () => {
    expect(rules('Visa processing fees will be paid by the company.')).toEqual([]);
    expect(rules('We offer competitive pay and reimburse certification fees.')).toEqual([]);
    expect(rules('Background check fees are the responsibility of the company.')).toEqual([]);
    expect(rules('Relocation assistance: we reimburse moving costs and pay all immigration filing fees.')).toEqual([]);
    expect(rules('All onboarding fees are fully covered.')).toEqual([]);
    expect(rules('Company-paid certification fees and a training budget.')).toEqual([]);
    expect(rules('The background check fee is handled at our expense.')).toEqual([]);
    expect(rules('There is no fee to apply.')).toEqual([]);
  });

  it('still flags a fee when "we pay" is only about wages, and the buy-then-reimburse pattern despite employer wording', () => {
    expect(rules('We pay weekly; a starter kit fee of $60 is required before training.')).toEqual(['intl_fee_required']);
    expect(rules('You will buy a laptop from our vendor and be reimbursed by the company with your first check.')).toEqual(['intl_fee_required']);
    expect(rules('A refundable deposit of $100 is required and will be reimbursed after 30 days.')).toEqual(['intl_fee_required']);
  });

  it('does not treat video tools or messaging-product work as a contact route (review fixtures)', () => {
    expect(rules('Interviews will be conducted via Google Hangouts.')).toEqual([]);
    expect(rules('Experience with the WhatsApp Business API and contact center platforms.')).toEqual([]);
    expect(rules('You will connect our CRM with WhatsApp through webhooks.')).toEqual([]);
    expect(rules('Build Telegram bots that message our recruiters about new tickets.')).toEqual([]);
  });

  it('flags the app followed by an applicant-contact intent', () => {
    expect(rules('WhatsApp our recruiter at +1 555 0100 to apply.')).toEqual(['intl_messaging_app_only']);
    expect(rules('Telegram: @hiring_desk for an interview.')).toEqual(['intl_messaging_app_only']);
    expect(rules('Apply here: t.me/fastjobs_hr')).toEqual(['intl_messaging_app_only']);
  });

  it('is intl only: GoApply jobs use the CN classifier (WP-41)', () => {
    expect(detectScamSignals('A one-time training fee of $85 is due before your first shift.', 'cn')).toEqual([]);
  });

  it('caps long quotes and keeps them verbatim', () => {
    const long = `${'Lorem ipsum dolor sit amet '.repeat(12)}you must pay a registration fee before starting ${'consectetur adipiscing '.repeat(10)}`;
    const [signal] = detectScamSignals(long);
    expect(signal!.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(long).toContain(signal!.quote);
    expect(signal!.quote).toContain('registration fee');
  });

  it('splits sentences in English and Chinese', () => {
    expect(splitSentences('One. Two!\nThree。四？').map((s) => s.text)).toEqual(['One.', 'Two!', 'Three。', '四？']);
  });
});

describe('fraud flag merge', () => {
  const at = new Date('2026-10-10T00:00:00.000Z');

  it('keeps other rules, replaces intl rules and keeps the original timestamp of an unchanged flag', () => {
    const existing = [
      { rule: 'cn_training_loan', evidence: '培训贷', at: '2026-01-01T00:00:00.000Z' },
      { rule: 'intl_fee_required', evidence: 'old fee sentence', at: '2026-02-01T00:00:00.000Z' },
      { rule: 'intl_pay_to_apply', evidence: 'There is a $25 application fee.', at: '2026-03-01T00:00:00.000Z' },
    ];
    const next = toFraudFlags([{ rule: 'intl_pay_to_apply', quote: 'There is a $25 application fee.' }], at);
    expect(mergeFraudFlags(existing, next)).toEqual([
      { rule: 'cn_training_loan', evidence: '培训贷', at: '2026-01-01T00:00:00.000Z' },
      { rule: 'intl_pay_to_apply', evidence: 'There is a $25 application fee.', at: '2026-03-01T00:00:00.000Z' },
    ]);
  });

  it('returns null when nothing is flagged and ignores malformed entries', () => {
    expect(mergeFraudFlags(null, [])).toBeNull();
    expect(mergeFraudFlags([{ rule: 'intl_fee_required', evidence: 'x', at: 'y' }, 'junk', { rule: 1 }], [])).toBeNull();
  });
});
