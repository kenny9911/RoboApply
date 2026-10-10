// @vitest-environment node
//
// WP-72 — the coaching policy (F-COACH-02) per brand: content/legal/{intl,cn}/coaching.md.
// Draft until counsel approves; every placeholder fills; it covers booking
// ahead, cancelling, missed sessions, direct payment to the coach (no
// platform payment, no CN rails), and real coaches only.

import { describe, expect, it } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
// Test-only reach into the compliance loader (not a runtime import).
import { loadLegalDoc, parseFrontMatter, readLegalSource } from '../compliance/legalDocs.js';
import { LEGAL_DOC_FILES } from '../compliance/contract.js';

describe('coaching policy', () => {
  it.each(['intl', 'cn'] as const)('%s file exists, is a draft with a title and the required sections', (market) => {
    const src = readLegalSource(market, 'coaching');
    expect(src).toBeTruthy();
    const { meta, body } = parseFrontMatter(src!);
    expect(meta.status).toBe('draft');
    expect(meta.title).toBeTruthy();
    expect(body).toMatch(/DRAFT/);
    expect(body).not.toMatch(/RoboApply|GoApply/);
    const sections = market === 'intl'
      ? ['Who the coaches are', 'How booking works', 'Payment', 'Booking ahead', 'Cancelling and rescheduling', 'Missed sessions']
      : ['辅导老师是谁', '如何预约', '付款', '提前预约', '取消和改期', '缺席'];
    for (const h of sections) expect(body).toContain(`## ${h}`);
  });

  it('RoboApply serves /legal/coaching with every placeholder filled', () => {
    const ra = getBrand('roboapply');
    const doc = loadLegalDoc(ra, 'coaching', { env: { NODE_ENV: 'test' } });
    expect(doc.draft).toBe(true);
    expect(doc.markdown).not.toMatch(/\{\{|%BRAND%/);
    expect(doc.markdown).toContain(ra.name);
    expect(doc.markdown).toMatch(/takes no payment for coaching/);
  });

  it('the GoApply text exists for when the cn map lists it (requested from INT)', () => {
    const src = readLegalSource('cn', 'coaching')!;
    expect(src).toMatch(/不会通过本平台的支付渠道收取辅导费用/);
    // Until INT adds `coaching` to LEGAL_DOC_FILES.cn, GoApply answers 404 for /legal/coaching.
    if (!LEGAL_DOC_FILES.cn.coaching) expect(() => loadLegalDoc(getBrand('goapply'), 'coaching', { env: { NODE_ENV: 'test' } })).toThrow();
    else expect(loadLegalDoc(getBrand('goapply'), 'coaching', { env: { NODE_ENV: 'test' } }).markdown).not.toMatch(/\{\{/);
  });
});
