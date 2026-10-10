// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { SEEKER_CONSENT_TYPES } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { RecordConsentBodySchema } from './contract.js';
import {
  CONSENT_CATALOG,
  CONSENT_PROSE_VERSION,
  consentDefinitionsFor,
  consentProseHash,
  findConsentDefinition,
  initialConsentFormState,
  isConsentApplicable,
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

// ── WP-93: new catalog entries (wave 3 #11, wave 5 #40) ────────────────────

describe('new consent entries: listed for the right brand, unticked, hashed', () => {
  // `offered: false` = defined (a record can be written and read back) but not
  // put in front of the user by the catalog: GoApply never records video
  // (CN L-11), and the coaching share is asked on the coaching form only.
  const NEW: Array<{ brand: 'roboapply' | 'goapply'; type: string; zh: boolean; control: string; offered: boolean; draft?: true }> = [
    { brand: 'goapply', type: 'tips_reminders', zh: true, control: 'toggle', offered: true },
    { brand: 'goapply', type: 'interview_video', zh: true, control: 'toggle', offered: false },
    { brand: 'roboapply', type: 'interview_video', zh: false, control: 'toggle', offered: true },
    { brand: 'goapply', type: 'coaching_share_with_coach', zh: true, control: 'checkbox', offered: false, draft: true },
  ];

  it.each(NEW)('$brand $type: optional, in context, off by default, withdrawable', ({ brand, type, zh, control, offered, draft }) => {
    expect(SEEKER_CONSENT_TYPES).toContain(type);
    const def = findConsentDefinition(brand, type)!;
    expect(def).toBeTruthy();
    expect(def).toMatchObject({
      brand,
      requiredWhen: 'never',
      appliesWhen: offered ? 'always' : 'never',
      stage: 'in_context',
      control,
      withdrawable: true,
      onWithdraw: 'none',
      defaultGranted: false,
    });
    for (const env of [OFFSHORE, MAINLAND]) expect(isConsentApplicable(def, { env, country: 'TW', locale: 'zh-TW' })).toBe(offered);
    expect(isConsentRequired(def, { env: OFFSHORE })).toBe(false);
    expect(Boolean(def.prose.zh)).toBe(zh);
    expect(def.proseStatus).toBe(draft ? 'draft' : undefined);
    // Never part of the signup form, so it cannot arrive ticked with the account.
    expect(type in initialConsentFormState(brand, { env: OFFSHORE, country: 'TW' })).toBe(false);
    expect(validateSignupConsents(brand, [], { env: MAINLAND }).missing).not.toContain(type);
  });

  it.each(NEW)('$brand $type: starts unanswered, then records and withdraws with the prose hash', async ({ brand, type, zh, offered }) => {
    const b = getBrand(brand);
    const fake = db();
    const deps = { db: fake as unknown as ConsentDb, env: OFFSHORE, enqueue: vi.fn(), kick: vi.fn() };
    const locale = zh ? 'zh' : 'en';
    const listed = async () => (await listConsents('u1', b, { env: OFFSHORE, locale }, deps)).find((i) => i.type === type);

    const before = await listed();
    if (offered) {
      expect(before).toMatchObject({ granted: null, answeredAt: null, defaultGranted: false, required: false, withdrawable: true, proseLocale: locale });
    } else {
      // Not put in front of the user until a record of it exists.
      expect(before).toBeUndefined();
    }
    const prose = resolveConsentProse(findConsentDefinition(brand, type)!, b, locale);
    expect(prose.text).not.toContain('%BRAND%');
    if (before) expect(before).toMatchObject({ prose: prose.text, proseHash: prose.hash });

    const on = await recordConsent({ userId: 'u1', brand: b, type, granted: true, proseVersion: CONSENT_PROSE_VERSION, locale }, deps);
    expect(on.proseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(on.proseHash).toBe(prose.hash);
    expect(on.proseHash).toBe(consentProseHash({ brand, type, version: CONSENT_PROSE_VERSION, locale, text: prose.text }));
    expect(on.accountClosing).toBe(false);
    // Once answered it is listed for everyone, so it can be seen and withdrawn.
    expect(await listed()).toMatchObject({ granted: true, withdrawable: true, required: false, proseHash: prose.hash });
    // The ledger orders by createdAt: let the withdrawal land on a later millisecond than the grant.
    await new Promise((resolve) => setTimeout(resolve, 3));
    const off = await recordConsent({ userId: 'u1', brand: b, type, granted: false, proseVersion: CONSENT_PROSE_VERSION, locale }, deps);
    expect(off.accountClosing).toBe(false);
    expect(await listed()).toMatchObject({ granted: false });
    expect(fake.$rows('seekerConsentRecord').map((r) => [r.consentType, r.granted, r.proseHash, r.proseVersion])).toEqual([
      [type, true, on.proseHash, CONSENT_PROSE_VERSION],
      [type, false, on.proseHash, CONSENT_PROSE_VERSION],
    ]);
  });

  it('the coaching share consent is GoApply only (PIPL Art. 23) and names what is shared, with whom', async () => {
    expect(findConsentDefinition('roboapply', 'coaching_share_with_coach')).toBeNull();
    const def = findConsentDefinition('goapply', 'coaching_share_with_coach')!;
    for (const word of ['姓名', '邮箱', '留言', '独立教练']) expect(def.prose.zh).toContain(word);
    for (const word of ['name', 'email address', 'message', 'independent coach']) expect(def.prose.en).toContain(word);
    await expect(
      recordConsent(
        { userId: 'u1', brand: roboapply, type: 'coaching_share_with_coach', granted: true, proseVersion: CONSENT_PROSE_VERSION },
        { db: db() as unknown as ConsentDb, env: OFFSHORE, enqueue: vi.fn(), kick: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // Draft wording is flagged for counsel on this entry only.
    expect(CONSENT_CATALOG.filter((d) => d.proseStatus === 'draft').map((d) => `${d.brand}:${d.type}`)).toEqual(['goapply:coaching_share_with_coach']);
  });

  it('GoApply is never asked for camera recording: it records audio only (CN L-11)', async () => {
    const fake = db();
    const deps = { db: fake as unknown as ConsentDb, enqueue: vi.fn(), kick: vi.fn() };
    for (const env of [OFFSHORE, MAINLAND]) {
      for (const locale of ['zh', 'en']) {
        const types = (await listConsents('u1', goapply, { env, locale }, deps)).map((i) => i.type);
        expect(types).toContain('interview_recording');
        expect(types).not.toContain('interview_video');
        // The draft coaching wording is not a standalone switch either.
        expect(types).not.toContain('coaching_share_with_coach');
        expect(types).toContain('tips_reminders');
      }
    }
    // RoboApply does record video with this consent, so it is offered there.
    expect((await listConsents('u1', roboapply, { env: OFFSHORE }, deps)).map((i) => i.type)).toContain('interview_video');
  });

  it("GoApply tips and reminders: its own entry, with RoboApply's English text; RoboApply's entry is untouched", () => {
    const go = findConsentDefinition('goapply', 'tips_reminders')!;
    const robo = findConsentDefinition('roboapply', 'tips_reminders')!;
    expect(go.prose.en).toBe(robo.prose.en);
    expect(go.prose.zh).toContain('提醒');
    // A GoApply record written before the entry existed (RoboApply English text, GoApply brand) hashes the same.
    expect(resolveConsentProse(go, goapply, 'en').hash).toBe(
      consentProseHash({ brand: 'goapply', type: 'tips_reminders', version: CONSENT_PROSE_VERSION, locale: 'en', text: robo.prose.en }),
    );
    expect(robo).toMatchObject({ requiredWhen: 'never', stage: 'in_context', control: 'toggle', withdrawable: true });
  });

  it('video is its own consent: the recording consent still speaks of audio and transcript only', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      const rec = findConsentDefinition(brand, 'interview_recording')!;
      const video = findConsentDefinition(brand, 'interview_video')!;
      expect(rec.prose.en).toMatch(/audio and transcript/);
      expect(rec.prose.en).not.toMatch(/video|camera/i);
      expect(video.prose.en).toMatch(/camera/);
      expect(video.prose.en).toMatch(/90 days/);
      // Listed right after the recording consent it builds on.
      const types = consentDefinitionsFor(brand).map((d) => d.type);
      expect(types.indexOf('interview_video')).toBe(types.indexOf('interview_recording') + 1);
    }
  });
});

describe('adding entries changed no existing hash', () => {
  // sha256 prefix per brand:type:locale, taken before the WP-93 entries were added.
  const BEFORE: Record<string, string> = {
    'goapply:pipl_basic_processing:en': '1358a310e81e6fe2',
    'goapply:pipl_basic_processing:zh': '4a3a2d471461e4c0',
    'goapply:age_16_plus:en': '97b4c5279b6683db',
    'goapply:age_16_plus:zh': '85e605e450753480',
    'goapply:pipl_cross_border:en': 'ba9257c5a371cfa5',
    'goapply:pipl_cross_border:zh': '4b8785c70e410404',
    'goapply:ai_resume_parsing:en': '51f19aeb256f88f4',
    'goapply:ai_resume_parsing:zh': '167f7290a23733c7',
    'goapply:personalized_recommendation:en': '0a3d746fa7c9a04c',
    'goapply:personalized_recommendation:zh': '26bf438f496152ce',
    'goapply:marketing_email:en': 'a3a40d164376e1a8',
    'goapply:marketing_email:zh': '13d110dba9e7763f',
    'goapply:pipl_sensitive_pi:en': 'b725d149b5979290',
    'goapply:pipl_sensitive_pi:zh': 'f6f40b2c9e0d3acb',
    'goapply:autofill_sensitive:en': 'd881c26a3e488f67',
    'goapply:autofill_sensitive:zh': 'a98b58a52f2b121f',
    'goapply:share_with_gohire:en': '08d783c94786177f',
    'goapply:share_with_gohire:zh': '7699c0a214de41e9',
    'goapply:interview_recording:en': '485ba4eb2d6f5979',
    'goapply:interview_recording:zh': '5f6ecaae26a413d3',
    'goapply:copilot_memory:en': 'd94ebfbc5ca13789',
    'goapply:copilot_memory:zh': '361a655512df917f',
    'roboapply:age_16_plus:en': 'aff71c6c457e7d58',
    'roboapply:tw_pdpa_notice:en': '3c1c252464e538bd',
    'roboapply:marketing_email:en': '203995d810581c30',
    'roboapply:intl_cross_border_cn_parse:en': 'f03aa1327ea4127d',
    'roboapply:interview_recording:en': 'a1f1f0e841a3f3ea',
    'roboapply:copilot_memory:en': '014dd77504ce52be',
    'roboapply:autofill_sensitive:en': '8be8469e8d92ca23',
    'roboapply:tips_reminders:en': 'fa47d6c620da1dcc',
  };

  it('every earlier entry still hashes to the same value under the same prose version', () => {
    expect(CONSENT_PROSE_VERSION).toBe('2026-10-10.wp13.v1');
    const now: Record<string, string> = {};
    for (const d of CONSENT_CATALOG) {
      for (const locale of ['en', 'zh'] as const) {
        if (locale === 'zh' && !d.prose.zh) continue;
        now[`${d.brand}:${d.type}:${locale}`] = resolveConsentProse(d, getBrand(d.brand), locale).hash.slice(0, 16);
      }
    }
    for (const [key, hash] of Object.entries(BEFORE)) expect(now[key], key).toBe(hash);
    expect(Object.keys(BEFORE)).toHaveLength(30);
    // Exactly the new entries were added, nothing else.
    expect(Object.keys(now).filter((k) => !(k in BEFORE)).sort()).toEqual([
      'goapply:coaching_share_with_coach:en',
      'goapply:coaching_share_with_coach:zh',
      'goapply:interview_video:en',
      'goapply:interview_video:zh',
      'goapply:tips_reminders:en',
      'goapply:tips_reminders:zh',
      'roboapply:interview_video:en',
    ]);
  });
});
