// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { aiAllowed, isConsentLive, setConsentLookup, type ConsentRecordLike } from './aiAllowed.js';
import { setUserBrandLookup } from '../brand/userBrand.js';
import { runWithBrand } from '../../lib/requestContext.js';
import type { SeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import { SEEKER_CONSENT_TYPES } from '../../roboapply/engine/lib/seekerConsentTypes.js';

const t = (iso: string) => new Date(iso);
let records: Record<string, ConsentRecordLike[]> = {};

function installLookup() {
  setConsentLookup(async (userId: string, types: SeekerConsentType[]) => {
    const list = (records[userId] ?? []).filter((r) => (types as string[]).includes(r.consentType));
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list[0] ?? null;
  });
}

const userBrands: Record<string, string> = { u2: 'roboapply', u5: 'goapply', u6: 'goapply' };

afterEach(() => {
  records = {};
  setConsentLookup(null);
  setUserBrandLookup(null);
});

function installUserBrands() {
  setUserBrandLookup(async (userId) => userBrands[userId] ?? null);
}

describe('aiAllowed (H4)', () => {
  it.each([
    ['RoboApply, no consent records', 'roboapply', [], true],
    ['GoApply, no records', 'goapply', [], false],
    ['GoApply, grant', 'goapply', [{ consentType: 'ai_resume_parsing', granted: true, createdAt: t('2026-10-01') }], true],
    [
      'GoApply, grant then revoke',
      'goapply',
      [
        { consentType: 'ai_resume_parsing', granted: true, createdAt: t('2026-10-01') },
        { consentType: 'ai_resume_parsing', granted: false, createdAt: t('2026-10-02') },
      ],
      false,
    ],
    [
      'GoApply, revoke then re-grant',
      'goapply',
      [
        { consentType: 'ai_resume_parsing', granted: false, createdAt: t('2026-10-01') },
        { consentType: 'ai_resume_parsing', granted: true, createdAt: t('2026-10-03') },
      ],
      true,
    ],
    ['GoApply, legacy alias grant', 'goapply', [{ consentType: 'ai_resume_parse', granted: true, createdAt: t('2026-10-01') }], true],
    [
      'GoApply, alias grant overridden by newer canonical revoke',
      'goapply',
      [
        { consentType: 'ai_resume_parse', granted: true, createdAt: t('2026-10-01') },
        { consentType: 'ai_resume_parsing', granted: false, createdAt: t('2026-10-02') },
      ],
      false,
    ],
    ['GoApply, an unrelated grant only', 'goapply', [{ consentType: 'ai_assistance', granted: true, createdAt: t('2026-10-01') }], false],
  ])('%s → %s', async (_label, brand, recs, expected) => {
    records = { u1: recs as ConsentRecordLike[] };
    installLookup();
    expect(await aiAllowed({ id: 'u1', brand: brand as string })).toBe(expected);
    if (brand === 'goapply') expect(isConsentLive(recs as ConsentRecordLike[], 'ai_resume_parsing')).toBe(expected);
  });

  it('a bare user id uses the stored User.brand, never the ambient context', async () => {
    installLookup();
    installUserBrands();
    // RoboApply user: allowed even inside a GoApply context.
    expect(await aiAllowed('u2')).toBe(true);
    expect(await runWithBrand('goapply', () => aiAllowed('u2'))).toBe(true);
    // GoApply user with no consent, outside any context (legacy cron, webhook,
    // unbranded queue item) and inside a defaulted RoboApply context → false.
    expect(await aiAllowed('u5')).toBe(false);
    expect(await runWithBrand('roboapply', () => aiAllowed('u5'))).toBe(false);
    expect(await aiAllowed({ id: 'u5', brand: null })).toBe(false);
    // …and true once consent is live.
    records = { u6: [{ consentType: 'ai_resume_parsing', granted: true, createdAt: t('2026-10-01') }] };
    expect(await aiAllowed('u6')).toBe(true);
  });

  it('fails closed when the brand cannot be established', async () => {
    installLookup();
    installUserBrands();
    expect(await aiAllowed('unknown-user')).toBe(false);
    setUserBrandLookup(async () => {
      throw new Error('db down');
    });
    expect(await aiAllowed('u2')).toBe(false);
  });

  it('the user’s own brand wins over the request brand', async () => {
    installLookup();
    expect(await runWithBrand('goapply', () => aiAllowed({ id: 'u3', brand: 'roboapply' }))).toBe(true);
  });

  it('fails closed on GoApply when the lookup errors', async () => {
    setConsentLookup(async () => {
      throw new Error('db down');
    });
    expect(await aiAllowed({ id: 'u4', brand: 'goapply' })).toBe(false);
    expect(await aiAllowed({ id: 'u4', brand: 'roboapply' })).toBe(true);
  });
});

describe('consent type union', () => {
  it('contains the ARCH §2.13, CN §4.1(4) and FND-2a values and keeps the originals', () => {
    for (const type of [
      'seeker_app_optin', 'biometric_video', 'biometric_interview', 'auto_apply', 'external_board_share', 'transactional_email', 'marketing_email', 'ai_assistance',
      'pipl_basic_processing', 'pipl_cross_border', 'pipl_sensitive_pi', 'ai_resume_parsing', 'personalized_recommendation', 'interview_recording', 'share_with_gohire', 'age_16_plus', 'tw_pdpa_notice', 'intl_cross_border_cn_parse',
      'ai_resume_parse', 'sensitive_fields', 'share_with_employers', 'interview_video', 'autofill_sensitive',
      'copilot_memory', 'tips_reminders', 'auto_renew_ack', 'withdrawal_waiver', 'analytics',
    ]) {
      expect(SEEKER_CONSENT_TYPES).toContain(type);
    }
    expect(new Set(SEEKER_CONSENT_TYPES).size).toBe(SEEKER_CONSENT_TYPES.length);
  });
});
