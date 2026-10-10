// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { SEEKER_CONSENT_TYPES } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { RecordConsentBodySchema } from './contract.js';
import { buildDisclosures, configuredProcessors, storageCountry } from './disclosures.js';
import { describeProcessor, offshoreProcessors, unplacedProcessors } from './processingStatement.js';
import {
  answeredCurrentText,
  CONSENT_CATALOG,
  CONSENT_PROSE_LOCALES,
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
  servedConsentProseByHash,
  validateSignupConsents,
  type ConsentDb,
} from './consents.js';

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');
const OFFSHORE = { DEPLOY_REGION: '' };
const MAINLAND = { DEPLOY_REGION: 'cn-mainland' };
/** The deployment the browser check ran on: a Neon database in us-west-2 and a mainland AI model; no voice, no email, not on Vercel. */
const QA_ENV = { DEPLOY_REGION: '', DATABASE_URL: 'postgresql://u:p@ep-quiet.us-west-2.aws.neon.tech/db', CN_LLM_MODEL: 'deepseek/deepseek-v4-flash' };
/** A deployment with every offshore service on. */
const FULL_ENV = {
  DEPLOY_REGION: '',
  DATABASE_URL: 'postgresql://u:p@ep-quiet.us-east-1.aws.neon.tech/db',
  VERCEL: '1',
  RESEND_API_KEY: 'k',
  CN_EMAIL_TRANSPORT: 'resend',
  CN_LIVEKIT_URL: 'wss://lk.example',
  DEEPGRAM_API_KEY: 'k',
  CARTESIA_API_KEY: 'k',
  CN_LLM_MODEL: 'deepseek/deepseek-v4-flash',
};

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

  it('the cross-border prose carries no processor or region of its own: they come from configuration', () => {
    const def = findConsentDefinition('goapply', 'pipl_cross_border')!;
    for (const text of [def.prose.zh!, def.prose.en]) {
      expect(text).toContain('%OFFSHORE_PROCESSORS%');
      expect(text).not.toMatch(/Neon|Vercel|LiveKit|Deepgram|Cartesia|Resend|美国|United States|US East/);
    }
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

describe('consent prose and the legal disclosures state the same processors and AI destination (D3)', () => {
  const cross = findConsentDefinition('goapply', 'pipl_cross_border')!;
  const ai = findConsentDefinition('goapply', 'ai_resume_parsing')!;

  it('names exactly the configured offshore processors, with the region /legal shows — nothing that is switched off', () => {
    const zh = resolveConsentProse(cross, goapply, 'zh', QA_ENV).text;
    const en = resolveConsentProse(cross, goapply, 'en', QA_ENV).text;
    // /legal on this deployment: "Neon · 数据库 · US / us-west-2" and "deepseek · AI 模型 · CN".
    expect(buildDisclosures(goapply, QA_ENV).processors).toEqual([
      { name: 'Neon', purpose: 'database', country: 'US', region: 'us-west-2' },
      { name: 'deepseek', purpose: 'ai_models', country: 'CN', region: null },
    ]);
    expect(zh).toContain('境外处理方：数据库 Neon（美国，us-west-2）。');
    expect(en).toContain('Processors outside mainland China: Neon (database, United States, us-west-2). ');
    for (const text of [zh, en]) {
      expect(text).not.toMatch(/美国东部|US East/);
      expect(text).not.toMatch(/Vercel|LiveKit|Deepgram|Cartesia|Resend/);
      // A mainland AI provider is not an offshore processor.
      expect(text).not.toContain('deepseek');
      expect(text).not.toContain('%');
    }
  });

  it('every /legal processor row outside mainland China is in the consent, and no mainland one is', () => {
    for (const env of [QA_ENV, FULL_ENV]) {
      const rows = buildDisclosures(goapply, env).processors;
      for (const locale of ['zh', 'en'] as const) {
        const text = resolveConsentProse(cross, goapply, locale, env).text;
        for (const row of rows) {
          // GoApply's AI is mainland-only by routing, so no AI model row is a processor of this consent.
          if (row.country === 'CN' || row.purpose === 'ai_models') expect(text, row.name).not.toContain(row.name);
          else expect(text, row.name).toContain(describeProcessor(row, locale));
        }
      }
      expect(offshoreProcessors(goapply, env).map((p) => p.name)).toEqual(rows.filter((r) => r.country !== null && r.country !== 'CN').map((r) => r.name));
      expect(unplacedProcessors(goapply, env).map((p) => p.name)).toEqual(rows.filter((r) => r.country === null && r.purpose !== 'ai_models').map((r) => r.name));
    }
    const full = resolveConsentProse(cross, goapply, 'zh', FULL_ENV).text;
    const offshoreSentence = /境外处理方：([^。]*)。/.exec(full)![1]!;
    for (const name of ['Neon（美国，us-east-1）', 'Vercel（美国）', 'Resend（美国）', 'Deepgram（美国）', 'Cartesia（美国）']) expect(offshoreSentence).toContain(name);
    // A processor whose country the configuration does not establish is disclosed, in its own sentence — not called offshore.
    expect(offshoreSentence).not.toContain('LiveKit');
    expect(full).toContain('以下处理方的所在国家/地区未披露：语音练习 LiveKit Cloud。我同意');
    expect(resolveConsentProse(cross, goapply, 'en', FULL_ENV).text).toContain('Processors whose country is not listed: LiveKit Cloud (voice practice). I agree');
  });

  // Review finding: with a mainland bucket and a model vendor that has no known country, the
  // consent read "境外处理方：数据库 Neon（美国，us-west-2）、文件存储 Object storage (CN)（国家/地区未披露）、
  // AI 模型 siliconflow（国家/地区未披露）。" — a mainland bucket and a mainland-only AI route stated as offshore.
  it('a mainland bucket and a mainland-only AI route are never named as processors outside mainland China', () => {
    const env = {
      DEPLOY_REGION: '',
      DATABASE_URL: 'postgresql://u:p@ep-quiet.us-west-2.aws.neon.tech/db',
      CN_S3_BUCKET: 'goapply-files',
      CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
      CN_LLM_PROVIDER: 'siliconflow',
      CN_LLM_MODEL: 'Qwen/Qwen3-32B',
    };
    // /legal shows the bucket in mainland China; the unlisted vendor stays "Not listed" there.
    expect(configuredProcessors(goapply, env)).toEqual([
      { name: 'Neon', purpose: 'database', country: 'US', region: 'us-west-2' },
      { name: 'Object storage (CN)', purpose: 'storage', country: 'CN', region: null },
      { name: 'qwen', purpose: 'ai_models', country: 'CN', region: null },
    ]);
    const unlisted = { ...env, CN_LLM_MODEL: 'some-model' };
    expect(configuredProcessors(goapply, unlisted).at(-1)).toEqual({ name: 'siliconflow', purpose: 'ai_models', country: null, region: null });
    for (const e of [env, unlisted]) {
      expect(resolveConsentProse(cross, goapply, 'zh', e).text).toBe(
        '在当前内测阶段，你的个人信息在中国大陆境外处理和存储。境外处理方：数据库 Neon（美国，us-west-2）。我同意上述境外处理。我知道撤回此同意会关闭我的账户并删除我的数据。',
      );
      const en = resolveConsentProse(cross, goapply, 'en', e).text;
      expect(en).toContain('Processors outside mainland China: Neon (database, United States, us-west-2). I agree');
      expect(en).not.toMatch(/Object storage|siliconflow|qwen|not listed/i);
      // The AI consent that follows says the same thing about AI.
      expect(resolveConsentProse(ai, goapply, 'zh', e).text).toContain('AI 请求只发送到中国大陆境内的 AI 服务。');
    }
  });

  it('the bucket is in mainland China only when its endpoint establishes it', () => {
    const at = (endpoint: string | undefined, more: Record<string, string> = {}) => storageCountry(goapply, { CN_S3_BUCKET: 'b', ...(endpoint ? { CN_S3_ENDPOINT: endpoint } : {}), ...more });
    expect(at('https://oss-cn-shanghai.aliyuncs.com')).toBe('CN');
    expect(at('https://cos.ap-guangzhou.myqcloud.com')).toBe('CN');
    expect(at('https://obs.cn-north-4.myhuaweicloud.com')).toBe('CN');
    expect(at('https://files.example.cn', { CN_ALLOWED_STORAGE_HOST_SUFFIXES: 'example.cn' })).toBe('CN');
    // Not established: no endpoint, an offshore one, Aliyun Hong Kong, an in-cluster address on the offshore stack.
    expect(at(undefined)).toBeNull();
    expect(at('https://s3.us-east-1.amazonaws.com')).toBeNull();
    expect(at('https://oss-ap-southeast-1.aliyuncs.com')).toBeNull();
    expect(at('https://oss-cn-hongkong.aliyuncs.com')).toBeNull();
    expect(at('http://10.0.0.8:9000')).toBeNull();
    expect(at('http://10.0.0.8:9000', { DEPLOY_REGION: 'cn-mainland' })).toBe('CN');
    // The international bucket has no country we can read, whatever host it names.
    expect(storageCountry(roboapply, { S3_BUCKET: 'b', S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com' })).toBeNull();
    // A bucket with no established country is disclosed in its own sentence, not as offshore.
    const text = resolveConsentProse(cross, goapply, 'zh', { CN_S3_BUCKET: 'b', CN_S3_ENDPOINT: 'https://oss-cn-hongkong.aliyuncs.com' }).text;
    expect(text).toContain('以下处理方的所在国家/地区未披露：文件存储 Object storage (CN)。');
    expect(text).not.toContain('境外处理方：');
  });

  it('with no processor configured it names none and points at the Legal information page', () => {
    const zh = resolveConsentProse(cross, goapply, 'zh', {}).text;
    expect(buildDisclosures(goapply, {}).processors).toEqual([]);
    expect(zh).toContain('境外处理方的清单见“法律信息”页面。');
    expect(zh).not.toMatch(/Neon|Vercel|美国/);
    expect(resolveConsentProse(cross, goapply, 'en', {}).text).toContain('The processors are listed on the Legal information page. I agree');
  });

  it('the AI consent says where AI requests go, from the routing rule /legal prints', () => {
    expect(buildDisclosures(goapply, QA_ENV).llmEndpoints.rule).toBe('mainland_only');
    const zh = resolveConsentProse(ai, goapply, 'zh', QA_ENV).text;
    const en = resolveConsentProse(ai, goapply, 'en', QA_ENV).text;
    expect(zh).toContain('AI 请求只发送到中国大陆境内的 AI 服务。关闭时');
    expect(en).toContain('AI requests are sent only to AI services in mainland China. When this is off');
    // The old onboarding note claimed the opposite.
    expect(zh).not.toMatch(/境外/);
    expect(en).not.toMatch(/outside mainland China/);
  });

  it('a changed deployment changes the text and therefore the hash the record stores', () => {
    const a = resolveConsentProse(cross, goapply, 'zh', QA_ENV);
    const b = resolveConsentProse(cross, goapply, 'zh', FULL_ENV);
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).toBe(consentProseHash({ brand: 'goapply', type: 'pipl_cross_border', version: CONSENT_PROSE_VERSION, locale: 'zh', text: a.text }));
  });

  it('recordConsent and listConsents hash the text of the deployment they run on', async () => {
    const fake = db();
    const deps = { db: fake as unknown as ConsentDb, env: QA_ENV, enqueue: vi.fn(), kick: vi.fn() };
    const shown = (await listConsents('u1', goapply, { env: QA_ENV, locale: 'zh' }, deps)).find((i) => i.type === 'pipl_cross_border')!;
    expect(shown.prose).toContain('Neon（美国，us-west-2）');
    const res = await recordConsent({ userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: true, proseVersion: shown.proseVersion, locale: 'zh' }, deps);
    expect(res.proseHash).toBe(shown.proseHash);
    expect(fake.$rows('seekerConsentRecord')[0]).toMatchObject({ consentType: 'pipl_cross_border', proseHash: shown.proseHash });
  });

  it('no served text leaves a placeholder behind (both brands, every locale)', () => {
    for (const d of CONSENT_CATALOG) {
      for (const locale of CONSENT_PROSE_LOCALES) {
        expect(resolveConsentProse(d, getBrand(d.brand), locale, QA_ENV).text, `${d.brand}:${d.type}:${locale}`).not.toMatch(/%[A-Z_]+%/);
      }
    }
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
    expect(resolveConsentProse(def, roboapply, 'ja').proseLocale).toBe('en');
  });

  it('"Tips and reminders" is written in every locale of the brand (never English among translated text)', () => {
    const robo = findConsentDefinition('roboapply', 'tips_reminders')!;
    const english = robo.prose.en;
    const seen = new Set<string>();
    for (const locale of roboapply.locales) {
      const p = resolveConsentProse(robo, roboapply, locale);
      expect(p.proseLocale, locale).toBe(locale);
      expect(p.locale, locale).toBe(locale);
      if (locale !== 'en') expect(p.text, locale).not.toBe(english);
      expect(p.hash).toBe(consentProseHash({ brand: 'roboapply', type: 'tips_reminders', version: CONSENT_PROSE_VERSION, locale, text: p.text }));
      seen.add(p.text);
    }
    expect(seen.size).toBe(roboapply.locales.length);
    expect(resolveConsentProse(robo, roboapply, 'zh-TW').text).toMatch(/職缺/);
    expect(resolveConsentProse(robo, roboapply, 'ja').text).toMatch(/リマインダー/);
    const go = findConsentDefinition('goapply', 'tips_reminders')!;
    for (const locale of goapply.locales) expect(resolveConsentProse(go, goapply, locale).proseLocale).toBe(locale);
  });

  it('the notification settings show the translated text (the path the English sentence was seen on)', async () => {
    // GET /notifications/preferences builds the switch's text with `tipsConsentProse(brand, locale)`.
    const { tipsConsentProse } = await import('../notifications/index.js');
    const robo = findConsentDefinition('roboapply', 'tips_reminders')!;
    expect(tipsConsentProse(roboapply, 'ja').text).toBe(robo.prose.ja);
    expect(tipsConsentProse(roboapply, 'zh-TW').text).toBe(robo.prose['zh-TW']);
    expect(tipsConsentProse(roboapply, 'zh').text).toBe(robo.prose.zh);
    expect(tipsConsentProse(roboapply, 'ja').locale).toBe('ja');
    // GoApply's first visit has no locale cookie yet: Chinese, not English.
    expect(tipsConsentProse(goapply, null).text).toBe('向我发送与我收藏的职位和已开始的练习有关的小贴士和提醒。');
    for (const locale of ['zh', 'zh-TW', 'ja'] as const) expect(tipsConsentProse(roboapply, locale).text).not.toMatch(/^Send me tips/);
  });

  it('with no locale given the text is in the brand default language: GoApply Chinese, RoboApply English', () => {
    // The notification settings ask without a locale on a first visit (no locale cookie yet).
    const go = findConsentDefinition('goapply', 'tips_reminders')!;
    expect(resolveConsentProse(go, goapply, null).proseLocale).toBe('zh');
    expect(resolveConsentProse(go, goapply, undefined).text).toBe(go.prose.zh);
    expect(resolveConsentProse(go, goapply, 'en').text).toBe(go.prose.en);
    const robo = findConsentDefinition('roboapply', 'tips_reminders')!;
    expect(resolveConsentProse(robo, roboapply, null).proseLocale).toBe('en');
    // A locale the product does not have is English.
    expect(resolveConsentProse(robo, roboapply, 'xx').proseLocale).toBe('en');
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

  // Review finding: a grant given under the old cross-border text (v1: "Neon（美国东部）、Vercel、LiveKit Cloud、
  // Deepgram / Cartesia、Resend") was shown next to today's text as "you agreed to this".
  it('says which text an answer was given to: same words (even across a version bump) or a text that has since changed', async () => {
    const V1 = '2026-10-10.wp13.v1';
    const crossV1 =
      '在当前内测阶段，你的个人信息在中国大陆境外处理和存储，处理地区为美国。境外处理方：数据库 Neon（美国东部）、网站托管 Vercel（美国）、语音练习 LiveKit Cloud、语音识别与合成 Deepgram / Cartesia、邮件发送 Resend。' +
      '我同意上述境外处理。我知道撤回此同意会关闭我的账户并删除我的数据。';
    const agreement = resolveConsentProse(findConsentDefinition('goapply', 'pipl_basic_processing')!, goapply, 'zh', QA_ENV);
    const at = new Date('2026-10-10T08:00:00Z');
    const fake = db({
      seekerConsentRecord: [
        // Signed up under v1. The agreement's words did not change in v2; the cross-border text did.
        { id: 'c1', seekerProfileId: 'sp1', consentType: 'pipl_basic_processing', granted: true, createdAt: at, proseVersion: V1, proseHash: consentProseHash({ brand: 'goapply', type: 'pipl_basic_processing', version: V1, locale: 'zh', text: agreement.text }) },
        { id: 'c2', seekerProfileId: 'sp1', consentType: 'pipl_cross_border', granted: true, createdAt: at, proseVersion: V1, proseHash: consentProseHash({ brand: 'goapply', type: 'pipl_cross_border', version: V1, locale: 'zh', text: crossV1 }) },
        // A record with no hash (a sign-up form that stored none): it cannot be compared with any text.
        { id: 'c3', seekerProfileId: 'sp1', consentType: 'age_16_plus', granted: true, createdAt: at, proseVersion: null, proseHash: null },
      ],
    });
    const deps = { db: fake as unknown as ConsentDb, env: QA_ENV, enqueue: vi.fn(), kick: vi.fn() };
    const item = async (type: string, locale = 'zh') => (await listConsents('u1', goapply, { env: QA_ENV, locale }, deps)).find((i) => i.type === type)!;

    expect(await item('pipl_basic_processing')).toMatchObject({ granted: true, answeredProseVersion: V1, answeredTextCurrent: true });
    // Reading in another language does not make the agreed text "changed".
    expect(await item('pipl_basic_processing', 'en')).toMatchObject({ granted: true, answeredTextCurrent: true });
    expect(await item('pipl_cross_border')).toMatchObject({ granted: true, answeredProseVersion: V1, answeredTextCurrent: false, proseVersion: CONSENT_PROSE_VERSION });
    // Unknown, not "changed": nothing shows the text is different, so no screen may say it is (Wave FIX gate).
    expect(await item('age_16_plus')).toMatchObject({ granted: true, answeredProseVersion: null, answeredTextCurrent: null });
    // The same for a row that has a version but no hash (RoboApply sign-up; GoApply phone and WeChat sign-up before the gate).
    const ageDef = findConsentDefinition('goapply', 'age_16_plus')!;
    expect(answeredCurrentText(ageDef, goapply, { proseVersion: 'authCn.2026-10-10.v1', proseHash: null }, QA_ENV)).toBeNull();
    // A form sends back the hash of the text it showed: found in whichever language it was read in, under this deployment's facts.
    const cross = findConsentDefinition('goapply', 'pipl_cross_border')!;
    for (const lang of ['zh', 'en']) {
      const served = resolveConsentProse(cross, goapply, lang, QA_ENV);
      expect(servedConsentProseByHash(cross, goapply, served.hash, QA_ENV)).toMatchObject({ locale: lang, version: CONSENT_PROSE_VERSION, hash: served.hash });
    }
    expect(servedConsentProseByHash(cross, goapply, consentProseHash({ brand: 'goapply', type: 'pipl_cross_border', version: V1, locale: 'zh', text: crossV1 }), QA_ENV)).toBeNull();
    expect(servedConsentProseByHash(cross, goapply, undefined, QA_ENV)).toBeNull();
    expect(await item('marketing_email')).toMatchObject({ granted: null, answeredProseVersion: null, answeredTextCurrent: null });

    // Agreeing again records today's text; the answer is then current.
    await recordConsent({ userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: true, proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' }, deps);
    expect(await item('pipl_cross_border')).toMatchObject({ granted: true, answeredProseVersion: CONSENT_PROSE_VERSION, answeredTextCurrent: true });
    // The processor list is part of the text: when the deployment's processors change, the same record no longer matches.
    const moved = { ...QA_ENV, DATABASE_URL: 'postgresql://u:p@ep-quiet.ap-southeast-1.aws.neon.tech/db' };
    const after = (await listConsents('u1', goapply, { env: moved, locale: 'zh' }, { ...deps, env: moved })).find((i) => i.type === 'pipl_cross_border')!;
    expect(after.prose).toContain('Neon（新加坡，ap-southeast-1）');
    expect(after).toMatchObject({ granted: true, answeredTextCurrent: false });
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

  it("GoApply tips and reminders: its own entry, with RoboApply's English and Chinese text", () => {
    const go = findConsentDefinition('goapply', 'tips_reminders')!;
    const robo = findConsentDefinition('roboapply', 'tips_reminders')!;
    expect(go.prose.en).toBe(robo.prose.en);
    expect(go.prose.zh).toBe(robo.prose.zh);
    expect(go.prose.zh).toContain('提醒');
    // GoApply serves Chinese and English only.
    expect(Object.keys(go.prose).sort()).toEqual(['en', 'zh']);
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

describe('prose versions: a text changes only with a version bump, and a bump changes only what it says', () => {
  // sha256 prefix per brand:type:locale under version 2026-10-10.wp13.v1 (taken before the WP-93 entries were added).
  const V1: Record<string, string> = {
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

  /** Texts v2 rewrote: processors and the AI destination now come from configuration. */
  const REWRITTEN_IN_V2 = ['goapply:pipl_cross_border:en', 'goapply:pipl_cross_border:zh', 'goapply:ai_resume_parsing:en', 'goapply:ai_resume_parsing:zh'];

  // sha256 prefix per brand:type:locale under the current version, with nothing configured (env {}).
  const V2: Record<string, string> = {
    'goapply:pipl_basic_processing:en': '520789b8392a7cf9',
    'goapply:pipl_basic_processing:zh': 'bc9c1c6a359efe55',
    'goapply:age_16_plus:en': '235205d46c8b3a9e',
    'goapply:age_16_plus:zh': '052b27b977c8e832',
    'goapply:pipl_cross_border:en': '5b90dbaf7973bfe4',
    'goapply:pipl_cross_border:zh': 'ec75b61f2764e7b2',
    'goapply:ai_resume_parsing:en': '2d49bacc298e2b15',
    'goapply:ai_resume_parsing:zh': '8484633134ad37a2',
    'goapply:personalized_recommendation:en': 'f8d5d5d25bc6348f',
    'goapply:personalized_recommendation:zh': '3e414c9b2362f091',
    'goapply:marketing_email:en': '582311003969b3a6',
    'goapply:marketing_email:zh': '4d9416cc5d4e4d27',
    'goapply:pipl_sensitive_pi:en': '82feff7b98a0ddee',
    'goapply:pipl_sensitive_pi:zh': 'd5aca4f9e4fa5b6b',
    'goapply:autofill_sensitive:en': 'be54097ba0072f5c',
    'goapply:autofill_sensitive:zh': 'f752dbcc1fb37b45',
    'goapply:share_with_gohire:en': 'e32910cfc5afcd07',
    'goapply:share_with_gohire:zh': 'd8b6fa28701213bb',
    'goapply:interview_recording:en': '526dbae169d8e948',
    'goapply:interview_recording:zh': 'dde8bfe73d2fac19',
    'goapply:interview_video:en': '6c738e848857addb',
    'goapply:interview_video:zh': '8589338b3e7f306c',
    'goapply:copilot_memory:en': 'f39a6245df764e75',
    'goapply:copilot_memory:zh': 'a8bd05b5effd5fcc',
    'goapply:tips_reminders:en': 'bf9aa23bffe62f52',
    'goapply:tips_reminders:zh': 'ccebbe7a123b8298',
    'goapply:coaching_share_with_coach:en': 'c11bd815a46b3b36',
    'goapply:coaching_share_with_coach:zh': '70415c45e35dce55',
    'roboapply:age_16_plus:en': 'b093ab321dfb006f',
    'roboapply:tw_pdpa_notice:en': '872c42cfee8666d1',
    'roboapply:marketing_email:en': '7132496df319938b',
    'roboapply:intl_cross_border_cn_parse:en': '2190186fd797eb06',
    'roboapply:interview_recording:en': '8edaa37d2368f655',
    'roboapply:interview_video:en': '2f6afbfd5ba14ce5',
    'roboapply:copilot_memory:en': '0766eaa608584af4',
    'roboapply:autofill_sensitive:en': 'd9d61f49030ce8ae',
    'roboapply:tips_reminders:en': '4459a8ef7004acac',
    'roboapply:tips_reminders:zh': '1f4fe85afa867702',
    'roboapply:tips_reminders:zh-TW': 'f98cd5418ec20ef9',
    'roboapply:tips_reminders:ja': '1035f6f39966db9a',
    'roboapply:tips_reminders:ko': 'ce2839af3d663f15',
    'roboapply:tips_reminders:es': '03f102a062949132',
    'roboapply:tips_reminders:fr': '43f61af437fbaa69',
    'roboapply:tips_reminders:pt': '57a9ad83e972afdb',
    'roboapply:tips_reminders:de': '63b4e4404bf7de39',
  };

  /** Every text the catalog can serve, resolved with nothing configured. */
  function served(): Array<{ key: string; brand: 'roboapply' | 'goapply'; type: string; locale: string; text: string; hash: string }> {
    const out = [];
    for (const d of CONSENT_CATALOG) {
      for (const locale of CONSENT_PROSE_LOCALES) {
        if (!d.prose[locale]) continue;
        const p = resolveConsentProse(d, getBrand(d.brand), locale, {});
        out.push({ key: `${d.brand}:${d.type}:${locale}`, brand: d.brand, type: d.type, locale, text: p.text, hash: p.hash });
      }
    }
    return out;
  }

  it('every text hashes to its pinned value under the current version (a changed text needs a new version)', () => {
    expect(CONSENT_PROSE_VERSION).toBe('2026-10-11.fix8.v2');
    const now = Object.fromEntries(served().map((p) => [p.key, p.hash.slice(0, 16)]));
    expect(now).toEqual(V2);
  });

  it('the v2 bump rewrote only the cross-border and AI-processing texts: every other v1 text is word for word the same', () => {
    expect(Object.keys(V1)).toHaveLength(30);
    const byKey = new Map(served().map((p) => [p.key, p]));
    for (const [key, hash] of Object.entries(V1)) {
      const p = byKey.get(key)!;
      const underV1 = consentProseHash({ brand: p.brand, type: p.type, version: '2026-10-10.wp13.v1', locale: p.locale, text: p.text }).slice(0, 16);
      if (REWRITTEN_IN_V2.includes(key)) expect(underV1, key).not.toBe(hash);
      else expect(underV1, key).toBe(hash);
    }
  });
});
