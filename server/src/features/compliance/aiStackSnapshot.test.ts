// @vitest-environment node
//
// The AI stack snapshot (review finding: consent text, hash and requirement
// must not depend on a lazily warmed cache).
//
// The admin model overrides live in the database (`llm_stack.*`). The consent
// text, its hash and the cross-border requirement read them, so every async
// entry point of this area loads them first (`loadAiStackSnapshot`). These
// tests seed an override and prove that a cold instance and a warm instance
// give the same text, the same hash and the same requirement.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  reads: [] as string[],
  fail: false,
}));

vi.mock('../../lib/prisma.js', () => {
  const prisma = {
    appConfig: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        h.reads.push(where.key);
        if (h.fail) throw new Error('database unreachable');
        const value = h.rows.get(where.key);
        return value ? { key: where.key, value, updatedAt: new Date(), updatedBy: 'admin' } : null;
      },
    },
  };
  return { prisma, default: prisma };
});
vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { invalidateLlmStack } from '../../lib/llm/llmStackConfigResolver.js';
import { emptyLlmStackBlob, type LlmStackConfigBlob } from '../../lib/llm/llmStackConfigSchema.js';
import { getBrand } from '../../platform/brand/registry.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { CONSENT_PROSE_VERSION, findConsentDefinition, isConsentRequired, listConsents, recordConsent, resolveConsentProse, type ConsentDb } from './consents.js';
import { aiLeavesMainland, buildDisclosures, configuredModels, crossBorderConsentApplies, loadAiStackSnapshot, ownStackLeavesMainland } from './disclosures.js';
import { requiredSignupConsents } from '../auth-cn/signupPolicy.js';
import { aiPlaceSentence } from './processingStatement.js';

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');

/** A complete stack of GoApply's own on a mainland deployment: by the environment alone nothing leaves the mainland. */
const MAINLAND_OWN: Record<string, string> = {
  DEPLOY_REGION: 'cn-mainland',
  DATABASE_URL: 'postgresql://u:p@10.0.0.12:5432/goapply',
  CN_LLM_PROVIDER: 'deepseek',
  CN_LLM_MODEL: 'deepseek-chat',
  CN_LIVEKIT_URL: 'wss://rtc.goapply.example.cn',
  CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer',
  CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/cosyvoice',
  CN_S3_BUCKET: 'cn',
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_VAPID_PUBLIC_KEY: 'pub',
  CN_EMAIL_TRANSPORT: 'aliyun_dm',
};

function blob(patch: Partial<Omit<LlmStackConfigBlob, 'purposes'>> & { purposes?: Partial<LlmStackConfigBlob['purposes']> } = {}): LlmStackConfigBlob {
  const base = emptyLlmStackBlob();
  return { ...base, ...patch, purposes: { ...base.purposes, ...(patch.purposes ?? {}) } };
}

/** An admin override that sends the Assistant to an offshore gateway. */
const ASSISTANT_ABROAD = blob({ purposes: { copilot: 'openrouter/anthropic/claude-x' } });

describe('loadAiStackSnapshot with an explicit environment (the reader is passed in)', () => {
  const reader = (rows: { goapply?: LlmStackConfigBlob; roboapply?: LlmStackConfigBlob }) => async (id: 'goapply' | 'roboapply') => rows[id] ?? emptyLlmStackBlob();

  it('reads nothing for an env object unless a reader is passed: the database belongs to the live process', async () => {
    const env = { ...MAINLAND_OWN };
    await loadAiStackSnapshot(env);
    expect(h.reads).toEqual([]);
    expect(crossBorderConsentApplies(goapply, env)).toBe(false);
  });

  it("GoApply's own override is part of the list, the text and the requirement once the snapshot is loaded", async () => {
    const env = { ...MAINLAND_OWN };
    expect(aiLeavesMainland(goapply, env)).toBe(false);
    await loadAiStackSnapshot(env, reader({ goapply: ASSISTANT_ABROAD }));
    expect(configuredModels(goapply, env)).toEqual([
      { task: 'default', vendor: 'deepseek', model: 'deepseek-chat', region: 'CN', filingNo: null, source: 'own' },
      { task: 'assistant', vendor: 'openrouter', model: 'anthropic/claude-x', region: 'US', filingNo: null, source: 'override' },
    ]);
    expect(aiLeavesMainland(goapply, env)).toBe(true);
    expect(crossBorderConsentApplies(goapply, env)).toBe(true);
    expect(isConsentRequired(findConsentDefinition('goapply', 'pipl_cross_border')!, { env })).toBe(true);
    expect(aiPlaceSentence(goapply, env, 'zh')).toBe('AI 请求会发送到这些 AI 服务：deepseek（中国大陆）、openrouter（美国）。');
    expect(buildDisclosures(goapply, env).offshore).toBe(true);
    // Another env object holds no snapshot: nothing leaks from one environment to another.
    expect(aiLeavesMainland(goapply, { ...MAINLAND_OWN })).toBe(false);
  });

  it('resolves per key in the order of the model resolver: its override, CN_ value, the shared override, the shared value', async () => {
    const env = { ...MAINLAND_OWN, LLM_PROVIDER: 'openrouter', LLM_VISION_MODEL: 'gpt-5-vision', LLM_ENRICH_MODEL: 'google/gemini-x', CN_LLM_WRITING_MODEL: 'deepseek-writer' };
    await loadAiStackSnapshot(
      env,
      reader({
        goapply: blob({ defaultModel: 'glm/glm-5', purposes: { writing: 'kimi/kimi-k3' } }),
        // The shared stack's own overrides: its provider, and its vision and matching models.
        roboapply: blob({ provider: 'openai', purposes: { vision: 'gpt-6-vision', matching: 'gpt-6-mini' } }),
      }),
    );
    expect(configuredModels(goapply, env).map((m) => [m.task, m.vendor, m.model, m.source])).toEqual([
      ['default', 'glm', 'glm-5', 'override'], // its override wins over CN_LLM_MODEL
      ['matching', 'openai', 'gpt-6-mini', 'shared'], // the shared override, a bare id on the SHARED provider (its override too)
      ['writing', 'kimi', 'kimi-k3', 'override'], // its override wins over CN_LLM_WRITING_MODEL
      ['enrich', 'google', 'gemini-x', 'shared'], // the shared env value
      ['vision', 'openai', 'gpt-6-vision', 'shared'], // the shared override wins over LLM_VISION_MODEL
    ]);
    // RoboApply reads only the shared stack; its own override is labelled as such.
    expect(configuredModels(roboapply, env).map((m) => [m.task, m.vendor, m.model, m.source])).toEqual([
      ['matching', 'openai', 'gpt-6-mini', 'override'],
      ['enrich', 'google', 'gemini-x', 'shared'],
      ['vision', 'openai', 'gpt-6-vision', 'override'],
    ]);
  });

  it("a provider override of GoApply's own decides where its bare ids go", async () => {
    const env = { ...MAINLAND_OWN };
    await loadAiStackSnapshot(env, reader({ goapply: blob({ provider: 'openai' }) }));
    expect(configuredModels(goapply, env)[0]).toMatchObject({ vendor: 'openai', model: 'deepseek-chat', region: 'US', source: 'own' });
    expect(crossBorderConsentApplies(goapply, env)).toBe(true);
  });

  it('a failed read keeps the snapshot already held', async () => {
    const env = { ...MAINLAND_OWN };
    await loadAiStackSnapshot(env, reader({ goapply: ASSISTANT_ABROAD }));
    await loadAiStackSnapshot(env, async () => {
      throw new Error('database unreachable');
    });
    expect(crossBorderConsentApplies(goapply, env)).toBe(true);
  });
});

describe('the live process: a cold instance and a warm instance serve the same consent', () => {
  const KEY_GOAPPLY = 'llm_stack.goapply.development';

  /** Everything in the real environment that the disclosures read is blanked, then the fixture is set: the test never depends on a developer's `.env`. */
  function stubLiveEnv(values: Record<string, string>): void {
    const READ = /^(CN_|LLM_|S3_|LIVEKIT_|VAPID_|DEEPGRAM_|CARTESIA_|RESEND_|STRIPE_|ALIYUN_|ALIPAY_|WECHAT|VERCEL|INTERVIEW_ENGINE_|GOHIRE_|DEPLOY_REGION$|ALLOWED_BRANDS$|BRAND_LOCK$|LEGAL_|SUPPORT_EMAIL$)/;
    for (const name of Object.keys(process.env)) if (READ.test(name)) vi.stubEnv(name, '');
    vi.stubEnv('NODE_ENV', 'test');
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  }

  /** A fresh instance: no settings cache, no snapshot. */
  async function coldStart(): Promise<void> {
    vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true');
    await loadAiStackSnapshot(); // drops the snapshot of the live process
    vi.stubEnv('LLM_SETTINGS_DB_DISABLED', '');
    invalidateLlmStack();
    h.reads.length = 0;
  }

  function db(): ConsentDb {
    return createFakePrisma({ seed: { seekerProfile: [{ id: 'sp1', userId: 'u1' }] } }) as unknown as ConsentDb;
  }
  const deps = (d: ConsentDb) => ({ db: d, enqueue: vi.fn(async () => ({ id: 'w1', kind: 'k', status: 'queued', dedupeKey: null, created: true })) as never, kick: vi.fn() });

  beforeEach(async () => {
    h.rows.clear();
    h.fail = false;
    stubLiveEnv(MAINLAND_OWN);
    h.rows.set(KEY_GOAPPLY, JSON.stringify(ASSISTANT_ABROAD));
    await coldStart();
  });
  afterEach(async () => {
    await coldStart();
    vi.unstubAllEnvs();
    invalidateLlmStack();
  });

  it('the fixture is hermetic: by the environment alone nothing leaves the mainland', () => {
    // A synchronous caller that did not load the snapshot reads the environment only. This is why every entry point awaits it.
    expect(crossBorderConsentApplies(goapply)).toBe(false);
    expect(configuredModels(goapply).map((m) => `${m.vendor}/${m.model}`)).toEqual(['deepseek/deepseek-chat']);
  });

  it('listConsents on a cold instance already serves the override: same text, hash and requirement on the first and on later calls', async () => {
    const d = db();
    const first = await listConsents('u1', goapply, { locale: 'zh' }, deps(d));
    expect([...h.reads].sort()).toEqual(['llm_stack.development', KEY_GOAPPLY]);
    const cross = first.find((i) => i.type === 'pipl_cross_border')!;
    expect(cross).toMatchObject({ required: true, onWithdraw: 'close_and_purge_account', proseVersion: CONSENT_PROSE_VERSION });
    expect(cross.prose).toContain('openrouter（美国）');
    const ai = first.find((i) => i.type === 'ai_resume_parsing')!;
    expect(ai.prose).toContain('openrouter（美国）');

    for (let i = 0; i < 3; i += 1) {
      const again = await listConsents('u1', goapply, { locale: 'zh' }, deps(d));
      expect(again.find((x) => x.type === 'pipl_cross_border')).toMatchObject({ required: true, proseHash: cross.proseHash, prose: cross.prose });
      expect(again.find((x) => x.type === 'ai_resume_parsing')!.proseHash).toBe(ai.proseHash);
    }
    // The synchronous readers now agree with what was served.
    const def = findConsentDefinition('goapply', 'pipl_cross_border')!;
    expect(resolveConsentProse(def, goapply, 'zh').hash).toBe(cross.proseHash);
    expect(isConsentRequired(def, {})).toBe(true);
  });

  it('a grant recorded on another cold instance stores the hash the first instance served, and is not shown as "the text changed"', async () => {
    const d = db();
    const served = (await listConsents('u1', goapply, { locale: 'zh' }, deps(d))).find((i) => i.type === 'pipl_cross_border')!;

    await coldStart(); // the POST lands on an instance that has served nothing yet
    const recorded = await recordConsent({ userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: true, proseVersion: served.proseVersion, locale: 'zh' }, deps(d));
    expect(recorded.proseHash).toBe(served.proseHash);

    await coldStart(); // and the panel is read on a third one
    const after = (await listConsents('u1', goapply, { locale: 'zh' }, deps(d))).find((i) => i.type === 'pipl_cross_border')!;
    expect(after).toMatchObject({ granted: true, required: true, answeredTextCurrent: true, proseHash: served.proseHash });
  });

  it('a withdrawal on a cold instance closes the account: the override is what makes the consent apply', async () => {
    const d = db();
    const out = await recordConsent({ userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: false, proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' }, deps(d));
    expect(out.accountClosing).toBe(true);
  });

  it('without the override the same deployment does not ask for the consent, cold or warm', async () => {
    h.rows.clear();
    await coldStart();
    const d = db();
    for (let i = 0; i < 2; i += 1) {
      const items = await listConsents('u1', goapply, { locale: 'zh' }, deps(d));
      expect(items.find((x) => x.type === 'pipl_cross_border')).toBeUndefined();
    }
    const out = await recordConsent({ userId: 'u1', brand: goapply, type: 'pipl_cross_border', granted: false, proseVersion: CONSENT_PROSE_VERSION, locale: 'zh' }, deps(d));
    expect(out.accountClosing).toBe(false);
  });

  it('building the routers for the live process starts loading the snapshot, once (a router built with a test env reads nothing)', async () => {
    const { createComplianceRouter, createLegalPublicRouter } = await import('./routes.js');
    createLegalPublicRouter({ env: { ...MAINLAND_OWN } });
    expect(h.reads).toEqual([]);
    createLegalPublicRouter();
    createComplianceRouter();
    await vi.waitFor(() => expect(crossBorderConsentApplies(goapply)).toBe(true));
    expect([...h.reads].sort()).toEqual(['llm_stack.development', KEY_GOAPPLY]);
  });

  it('the public routes load the snapshot themselves: a cold instance serves the override in the consent text, the models and the privacy notice', async () => {
    const { createLegalPublicRouter } = await import('./routes.js');
    const { startRouteHarness } = await import('../../test/routeHarness.js');
    const harness = await startRouteHarness({ env: { NODE_ENV: 'test' }, mounts: [['/p', createLegalPublicRouter()]] });
    try {
      // Let any warm-up that building the router started finish, then start cold.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await coldStart();
      const host = 'goapply.localhost:3611';
      type Item = { type: string; required: boolean; prose: string; proseHash: string };
      const consents = await harness.request<{ data: { items: Item[] } }>('GET', '/p/consents?locale=zh', { host });
      const cross = consents.body.data.items.find((i) => i.type === 'pipl_cross_border')!;
      expect(cross.required).toBe(true);
      expect(cross.prose).toContain('openrouter（美国）');

      await coldStart();
      const disclosures = await harness.request<{ data: { offshore: boolean; models: Array<{ vendor: string; source: string }> } }>('GET', '/p/disclosures', { host });
      expect(disclosures.body.data.offshore).toBe(true);
      expect(disclosures.body.data.models.map((m) => `${m.vendor}:${m.source}`)).toEqual(['deepseek:own', 'openrouter:override']);

      await coldStart();
      const footer = await harness.request<{ data: { aiModels: Array<{ vendor: string }> } }>('GET', '/p/footer', { host });
      expect(footer.body.data.aiModels.map((m) => m.vendor)).toEqual(['deepseek', 'openrouter']);

      await coldStart();
      const privacy = await harness.request<{ data: { markdown: string } }>('GET', '/p/privacy', { host });
      expect(privacy.body.data.markdown).toContain('openrouter（美国）');
      expect(privacy.body.data.markdown).not.toContain('你的个人信息在中国大陆境内处理和存储。');

      // Another cold instance serves the same hash.
      await coldStart();
      const again = await harness.request<{ data: { items: Item[] } }>('GET', '/p/consents?locale=zh', { host });
      expect(again.body.data.items.find((i) => i.type === 'pipl_cross_border')!.proseHash).toBe(cross.proseHash);
    } finally {
      await harness.close();
    }
  });

  it('LLM_SETTINGS_DB_DISABLED: no row is read and the environment alone decides', async () => {
    vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true');
    const items = await listConsents('u1', goapply, { locale: 'zh' }, deps(db()));
    expect(h.reads).toEqual([]);
    expect(items.find((x) => x.type === 'pipl_cross_border')).toBeUndefined();
  });

  it('the settings row cannot be read: the request is still served, from the environment', async () => {
    h.fail = true;
    const items = await listConsents('u1', goapply, { locale: 'zh' }, deps(db()));
    expect(items.find((x) => x.type === 'ai_resume_parsing')!.prose).toContain('deepseek（中国大陆）');
  });
});

describe("a provider of GoApply's own that is itself outside the mainland (own is not mainland)", () => {
  const cross = (env: Record<string, string>) => ({
    own: ownStackLeavesMainland(goapply, env),
    consent: crossBorderConsentApplies(goapply, env),
    required: isConsentRequired(findConsentDefinition('goapply', 'pipl_cross_border')!, { env }),
    disclosed: buildDisclosures(goapply, env).offshore,
  });
  const yes = { own: true, consent: true, required: true, disclosed: true };
  const no = { own: false, consent: false, required: false, disclosed: false };

  it('the complete mainland stack: nothing leaves, no cross-border consent', () => {
    expect(cross({ ...MAINLAND_OWN })).toEqual(no);
    // An in-cluster bucket on the mainland deployment, and a host the operator lists as mainland storage.
    expect(cross({ ...MAINLAND_OWN, CN_S3_ENDPOINT: 'http://10.0.0.5:9000' })).toEqual(no);
    expect(cross({ ...MAINLAND_OWN, CN_S3_ENDPOINT: 'https://files.goapply.example.cn', CN_ALLOWED_STORAGE_HOST_SUFFIXES: 'goapply.example.cn' })).toEqual(no);
  });

  it('its own media plane on LiveKit Cloud: practice audio and video leave the mainland, so the consent is asked', async () => {
    const env = { ...MAINLAND_OWN, CN_LIVEKIT_URL: 'wss://goapply-a1b2c3.livekit.cloud' };
    expect(cross(env)).toEqual(yes);
    expect(buildDisclosures(goapply, env).processors.find((p) => p.purpose === 'voice')).toMatchObject({ name: 'LiveKit Cloud' });
    // Sign-up asks for what the catalog requires.
    expect((await requiredSignupConsents(env)).map((c) => c.type)).toContain('pipl_cross_border');
    expect((await requiredSignupConsents({ ...MAINLAND_OWN })).map((c) => c.type)).not.toContain('pipl_cross_border');
  });

  it('its own bucket outside the mainland: a foreign endpoint, or no endpoint at all (the provider default)', async () => {
    const foreign = { ...MAINLAND_OWN, CN_S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com' };
    expect(cross(foreign)).toEqual(yes);
    // The country of that bucket is not known, so none is printed (D3).
    expect(buildDisclosures(goapply, foreign).processors.find((p) => p.purpose === 'storage')).toMatchObject({ name: 'Object storage', country: null });
    expect((await requiredSignupConsents(foreign)).map((c) => c.type)).toContain('pipl_cross_border');
    const { CN_S3_ENDPOINT: _endpoint, ...noEndpoint } = MAINLAND_OWN;
    expect(cross(noEndpoint)).toEqual(yes);
  });

  it('never RoboApply, whatever the CN_ settings say', () => {
    const env = { ...MAINLAND_OWN, CN_LIVEKIT_URL: 'wss://goapply-a1b2c3.livekit.cloud', CN_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' };
    expect(ownStackLeavesMainland(roboapply, env)).toBe(false);
    expect(crossBorderConsentApplies(roboapply, env)).toBe(false);
  });
});
