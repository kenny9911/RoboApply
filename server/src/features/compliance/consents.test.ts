// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { SEEKER_CONSENT_TYPES } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { RecordConsentBodySchema } from './contract.js';
import {
  CONSENT_CATALOG,
  CONSENT_PROSE_VERSION,
  consentProseHash,
  findConsentDefinition,
  initialConsentFormState,
  isConsentRequired,
  listConsents,
  recordConsent,
  resolveConsentProse,
  validateSignupConsents,
  type ConsentDb,
} from './consents.js';

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');
const OFFSHORE = { DEPLOY_REGION: '' };
const MAINLAND = { DEPLOY_REGION: 'cn-mainland' };

function db(seed: Record<string, unknown[]> = {}) {
  return createFakePrisma({
    seed: { seekerProfile: [{ id: 'sp1', userId: 'u1' }], ...seed } as never,
    defaults: { rAPersonalInfoRequest: { status: 'open' } },
  });
}

describe('consent catalog (no optional consent pre-checked)', () => {
  it('every entry defaults to not granted and uses a known consent type', () => {
    for (const d of CONSENT_CATALOG) {
      expect(d.defaultGranted).toBe(false);
      expect(SEEKER_CONSENT_TYPES).toContain(d.type);
      expect(d.prose.en.length).toBeGreaterThan(10);
    }
  });

  it('the initial signup form state has nothing checked; personalisation starts unset', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      const state = initialConsentFormState(brand, { env: OFFSHORE, country: 'TW' });
      expect(Object.values(state).every((v) => v === false || v === null)).toBe(true);
    }
    expect(initialConsentFormState('goapply', { env: OFFSHORE }).personalized_recommendation).toBeNull();
  });

  it('GoApply prose exists in Chinese; no type appears twice per brand', () => {
    for (const d of CONSENT_CATALOG.filter((x) => x.brand === 'goapply')) expect(d.prose.zh).toBeTruthy();
    for (const brand of ['roboapply', 'goapply']) {
      const types = CONSENT_CATALOG.filter((d) => d.brand === brand).map((d) => d.type);
      expect(new Set(types).size).toBe(types.length);
    }
  });

  it('the cross-border prose names every offshore processor and the US region', () => {
    const def = findConsentDefinition('goapply', 'pipl_cross_border')!;
    for (const name of ['Neon', 'Vercel', 'LiveKit Cloud', 'Deepgram', 'Cartesia', 'Resend']) {
      expect(def.prose.zh).toContain(name);
      expect(def.prose.en).toContain(name);
    }
    expect(def.prose.zh).toContain('美国');
    expect(def.prose.zh).not.toMatch(/境内存储|数据不出境/);
  });

  it('required consents per brand and context', () => {
    const cross = findConsentDefinition('goapply', 'pipl_cross_border')!;
    expect(isConsentRequired(cross, { env: OFFSHORE })).toBe(true);
    expect(isConsentRequired(cross, { env: MAINLAND })).toBe(false);
    const tw = findConsentDefinition('roboapply', 'tw_pdpa_notice')!;
    expect(isConsentRequired(tw, { country: 'TW' })).toBe(true);
    expect(isConsentRequired(tw, { locale: 'zh-TW' })).toBe(true);
    expect(isConsentRequired(tw, { country: 'US', locale: 'en' })).toBe(false);
    expect(isConsentRequired(findConsentDefinition('roboapply', 'marketing_email')!, {})).toBe(false);
  });
});

describe('validateSignupConsents', () => {
  const grant = (type: string) => ({ type, granted: true, proseVersion: CONSENT_PROSE_VERSION });

  it('RoboApply needs age_16_plus (and the TW notice in Taiwan)', () => {
    expect(validateSignupConsents('roboapply', [], {}).missing).toEqual(['age_16_plus']);
    expect(validateSignupConsents('roboapply', [grant('age_16_plus')], {}).ok).toBe(true);
    expect(validateSignupConsents('roboapply', [grant('age_16_plus')], { country: 'TW' }).missing).toEqual(['tw_pdpa_notice']);
  });

  it('GoApply CN-0 needs the agreement, age and cross-border consent', () => {
    const r = validateSignupConsents('goapply', [grant('age_16_plus')], { env: OFFSHORE });
    expect(r.missing.sort()).toEqual(['pipl_basic_processing', 'pipl_cross_border']);
    const ok = validateSignupConsents('goapply', ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'].map(grant), { env: OFFSHORE });
    expect(ok.ok).toBe(true);
    expect(validateSignupConsents('goapply', ['pipl_basic_processing', 'age_16_plus'].map(grant), { env: MAINLAND }).ok).toBe(true);
  });

  it('rejects declined required consents, unknown types and outdated prose', () => {
    expect(validateSignupConsents('roboapply', [{ type: 'age_16_plus', granted: false, proseVersion: CONSENT_PROSE_VERSION }]).ok).toBe(false);
    expect(validateSignupConsents('roboapply', [grant('age_16_plus'), grant('pipl_cross_border')]).invalid).toEqual(['pipl_cross_border']);
    expect(validateSignupConsents('roboapply', [{ type: 'age_16_plus', granted: true, proseVersion: 'old' }]).invalid).toEqual(['age_16_plus']);
  });
});

describe('prose version and hash', () => {
  it('hashes the exact text, per brand, type, version and locale', () => {
    const def = findConsentDefinition('goapply', 'marketing_email')!;
    const zh = resolveConsentProse(def, goapply, 'zh');
    const en = resolveConsentProse(def, goapply, 'en');
    expect(zh.text).toContain('GoApply');
    expect(zh.text).not.toContain('%BRAND%');
    expect(zh.locale).toBe('zh');
    expect(en.locale).toBe('en');
    expect(zh.hash).not.toBe(en.hash);
    expect(zh.hash).toBe(consentProseHash({ brand: 'goapply', type: 'marketing_email', version: CONSENT_PROSE_VERSION, locale: 'zh', text: zh.text }));
    expect(zh.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serves English (and says so) where no translation exists', () => {
    const def = findConsentDefinition('roboapply', 'age_16_plus')!;
    expect(resolveConsentProse(def, roboapply, 'ja').locale).toBe('en');
  });

  it('the version fits the record column and the wire schema', () => {
    expect(CONSENT_PROSE_VERSION.length).toBeLessThanOrEqual(40);
    expect(RecordConsentBodySchema.safeParse({ type: 'analytics', granted: true, proseVersion: CONSENT_PROSE_VERSION }).success).toBe(true);
  });
});

describe('recordConsent', () => {
  it('writes the record with prose version + hash', async () => {
    const fake = db();
    const out = await recordConsent(
      { userId: 'u1', brand: goapply, type: 'ai_resume_parsing', granted: true, proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' },
      { db: fake as unknown as ConsentDb, env: OFFSHORE, enqueue: vi.fn(), kick: vi.fn() },
    );
    const rows = fake.$rows('seekerConsentRecord');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seekerProfileId: 'sp1', consentType: 'ai_resume_parsing', granted: true, proseVersion: CONSENT_PROSE_VERSION });
    expect(rows[0]!.proseHash).toBe(out.proseHash);
    expect(out.accountClosing).toBe(false);
  });

  it('records and withdraws autofill_sensitive on both brands (the gate WP-19 sensitiveForAutofill reads)', async () => {
    for (const brand of [roboapply, goapply]) {
      const def = findConsentDefinition(brand.id, 'autofill_sensitive')!;
      expect(def).toMatchObject({ requiredWhen: 'never', stage: 'in_context', withdrawable: true, defaultGranted: false });
      expect(def.prose.en).toMatch(/forms I open myself/);
      const fake = db();
      const deps = { db: fake as unknown as ConsentDb, env: OFFSHORE, enqueue: vi.fn(), kick: vi.fn() };
      await recordConsent({ userId: 'u1', brand, type: 'autofill_sensitive', granted: true, proseVersion: CONSENT_PROSE_VERSION }, deps);
      const out = await recordConsent({ userId: 'u1', brand, type: 'autofill_sensitive', granted: false, proseVersion: CONSENT_PROSE_VERSION }, deps);
      expect(out.accountClosing).toBe(false);
      expect(fake.$rows('seekerConsentRecord').map((r) => [r.consentType, r.granted])).toEqual([
        ['autofill_sensitive', true],
        ['autofill_sensitive', false],
      ]);
    }
  });

  it('409 on outdated prose, 422 on unknown or non-withdrawable', async () => {
    const deps = { db: db() as unknown as ConsentDb, env: OFFSHORE, enqueue: vi.fn(), kick: vi.fn() };
    await expect(recordConsent({ userId: 'u1', brand: goapply, type: 'ai_resume_parsing', granted: true, proseVersion: 'v0' }, deps)).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(recordConsent({ userId: 'u1', brand: roboapply, type: 'pipl_cross_border', granted: true, proseVersion: CONSENT_PROSE_VERSION }, deps)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(recordConsent({ userId: 'u1', brand: goapply, type: 'age_16_plus', granted: false, proseVersion: CONSENT_PROSE_VERSION }, deps)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('withdrawing pipl_cross_border in CN-0 opens a PI request and enqueues the purge', async () => {
    const fake = db();
    const enqueue = vi.fn(async () => ({ id: 'w1', kind: 'compliance.purge', status: 'queued' as const, dedupeKey: null, created: true }));
    const kick = vi.fn();
    const now = new Date('2026-10-12T09:00:00Z'); // Monday
    const out = await recordConsent(
      { userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: false, proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' },
      { db: fake as unknown as ConsentDb, env: OFFSHORE, enqueue, kick, now: () => now },
    );
    expect(out.accountClosing).toBe(true);
    const reqs = fake.$rows('rAPersonalInfoRequest');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ brand: 'goapply', userId: 'u1', kind: 'withdraw_consent', status: 'in_progress' });
    expect((reqs[0]!.dueAt as Date).toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(enqueue).toHaveBeenCalledWith(
      'compliance.purge',
      { userId: 'u1', piRequestId: reqs[0]!.id, reason: 'pipl_cross_border_withdrawn' },
      expect.objectContaining({ brand: 'goapply', userId: 'u1', dedupeKey: 'compliance.purge:u1' }),
    );
    expect(kick).toHaveBeenCalledWith(['compliance.purge']);
  });

  it('a retry after a failed enqueue reuses the open withdrawal request (one request, purge queued against it)', async () => {
    const fake = db();
    const kick = vi.fn();
    const failing = vi.fn(async () => {
      throw new Error('queue down');
    });
    const input = { userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: false, proseVersion: CONSENT_PROSE_VERSION };
    await expect(recordConsent(input, { db: fake as unknown as ConsentDb, env: OFFSHORE, enqueue: failing as never, kick })).rejects.toThrow('queue down');
    expect(fake.$rows('rAPersonalInfoRequest')).toHaveLength(1);
    const first = fake.$rows('rAPersonalInfoRequest')[0]!.id;

    const enqueue = vi.fn(async () => ({ id: 'w1', kind: 'compliance.purge', status: 'queued' as const, dedupeKey: null, created: true }));
    const out = await recordConsent(input, { db: fake as unknown as ConsentDb, env: OFFSHORE, enqueue, kick });
    expect(out.accountClosing).toBe(true);
    expect(fake.$rows('rAPersonalInfoRequest')).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith('compliance.purge', expect.objectContaining({ piRequestId: first }), expect.objectContaining({ dedupeKey: 'compliance.purge:u1' }));
  });

  it('the consent record and the withdrawal request are written in one transaction', async () => {
    const fake = db();
    const tx = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(fake));
    const wrapped = new Proxy(fake, { get: (t, p) => (p === '$transaction' ? tx : (t as unknown as Record<string | symbol, unknown>)[p]) });
    await recordConsent(
      { userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: false, proseVersion: CONSENT_PROSE_VERSION },
      { db: wrapped as unknown as ConsentDb, env: OFFSHORE, enqueue: vi.fn(async () => ({ id: 'w', kind: 'k', status: 'queued' as const, dedupeKey: null, created: true })), kick: vi.fn() },
    );
    expect(tx).toHaveBeenCalledTimes(1);
    expect(fake.$rows('seekerConsentRecord')).toHaveLength(1);
    expect(fake.$rows('rAPersonalInfoRequest')).toHaveLength(1);
  });

  it('withdrawing other consents (or on the mainland) does not purge', async () => {
    const enqueue = vi.fn();
    const deps = { db: db() as unknown as ConsentDb, env: MAINLAND, enqueue, kick: vi.fn() };
    await recordConsent({ userId: 'u1', brand: goapply, type: 'ai_resume_parsing', granted: false, proseVersion: CONSENT_PROSE_VERSION }, deps);
    const out = await recordConsent({ userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: false, proseVersion: CONSENT_PROSE_VERSION }, deps);
    expect(out.accountClosing).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('listConsents', () => {
  it('returns the catalog with the newest answer per type', async () => {
    const fake = db({
      seekerConsentRecord: [
        { id: 'c1', seekerProfileId: 'sp1', consentType: 'ai_resume_parsing', granted: true, createdAt: new Date('2026-10-01') },
        { id: 'c2', seekerProfileId: 'sp1', consentType: 'ai_resume_parsing', granted: false, createdAt: new Date('2026-10-02') },
      ],
    });
    const items = await listConsents('u1', goapply, { env: OFFSHORE, locale: 'zh' }, { db: fake as unknown as ConsentDb });
    const ai = items.find((i) => i.type === 'ai_resume_parsing')!;
    expect(ai.granted).toBe(false);
    expect(ai.proseLocale).toBe('zh');
    expect(items.find((i) => i.type === 'personalized_recommendation')!.granted).toBeNull();
    expect(items.find((i) => i.type === 'pipl_cross_border')!.onWithdraw).toBe('close_and_purge_account');
    expect(items.every((i) => i.defaultGranted === false)).toBe(true);
    const mainland = await listConsents('u1', goapply, { env: MAINLAND }, { db: fake as unknown as ConsentDb });
    expect(mainland.some((i) => i.type === 'pipl_cross_border')).toBe(false);
  });

  it('404 without a seeker profile', async () => {
    await expect(listConsents('nobody', roboapply, {}, { db: db() as unknown as ConsentDb })).rejects.toMatchObject({ code: 'not_found' });
  });
});
