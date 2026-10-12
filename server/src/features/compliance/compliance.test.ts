// @vitest-environment node
//
// WP-13 pure-logic tests: PI request due dates and queue, AI labels, the
// PIPL Art. 24 explanation, disclosures and the legal footer.

import { describe, expect, it } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { runWithBrand } from '../../lib/requestContext.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import {
  IMPLICIT_LABEL_KEYS,
  IPTC_COMPOSITE_ALGORITHMIC,
  IPTC_TRAINED_ALGORITHMIC,
  explicitFooterLine,
  explicitLabelEnabled,
  implicitLabelMetadata,
  logAiContentLabel,
  newAiContentId,
  type AiLabelDb,
} from './aiLabel.js';
import { ICP_LOOKUP_URL, LEGAL_FOOTER_DOCS, PROCESSOR_PURPOSES, resolveLegalDocSlug } from './contract.js';
import { buildUserDataExport, exportSectionNames, type ExportDb } from './dataExport.js';
import { transportNameFor } from '../../platform/email/index.js';
import { GOAPPLY_DIRECT_PROVIDERS, MAINLAND_LLM_HOST_SUFFIXES, hostOf, isMainlandLlmHost } from '../../platform/llm/brandPolicy.js';
import { OPENROUTER_MAINLAND_UPSTREAMS, PROVIDER_DEFAULT_BASE_URLS, checkLlmEgress } from '../../platform/llm/egressPolicy.js';
import { residencySummary } from '../../platform/residency/summary.js';
import { jobDataAttributions } from '../jobs/data/index.js';
import {
  WEB_PUSH_PROCESSOR_NAME,
  aiLeavesMainland,
  buildDisclosures,
  buildLegalFooter,
  configuredModels,
  configuredProcessors,
  crossBorderConsentApplies,
  dataAttributions,
  llmEndpointFacts,
  llmEndpointRule,
  parseGenaiDisclosures,
  parseModelId,
  processingFacts,
} from './disclosures.js';
import { EXPLAIN_KEYS, explainMatch, type ExplainDimension } from './explainMatch.js';
import { processingFactsMarkdown } from './legalDocs.js';
import { aiPlaceSentence, offshoreProcessors } from './processingStatement.js';
import {
  addWorkingDays,
  adminListPiRequests,
  adminUpdatePiRequest,
  createPiRequest,
  listUserPiRequests,
  piRequestDueAt,
  toPiRequestView,
  type PiRequestDb,
} from './piRequests.js';

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');

// ── PI requests ────────────────────────────────────────────────────────────

describe('personal-information request due dates', () => {
  it('GoApply: 15 working days, skipping weekends', () => {
    expect(addWorkingDays(new Date('2026-10-16T10:00:00Z'), 1).toISOString()).toBe('2026-10-19T10:00:00.000Z'); // Fri → Mon
    expect(piRequestDueAt('goapply', new Date('2026-10-12T09:00:00Z')).toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(piRequestDueAt('goapply', new Date('2026-10-17T09:00:00Z')).toISOString()).toBe('2026-11-06T09:00:00.000Z'); // Saturday filing
  });

  it('RoboApply: 30 calendar days', () => {
    expect(piRequestDueAt('roboapply', new Date('2026-10-12T09:00:00Z')).toISOString()).toBe('2026-11-11T09:00:00.000Z');
  });
});

describe('personal-information request queue', () => {
  const now = new Date('2026-10-12T09:00:00Z');
  const fake = () => createFakePrisma({ defaults: { rAPersonalInfoRequest: { status: 'open', closedAt: null } } });

  it('creates with the brand due date; a second open request of the same kind is 409', async () => {
    const db = fake();
    const deps = { db: db as unknown as PiRequestDb, now: () => now };
    const row = await createPiRequest({ userId: 'u1', brand: 'goapply', kind: 'access', userNote: 'Everything please' }, deps);
    expect(row.dueAt.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(row.detail).toEqual({ userNote: 'Everything please' });
    await expect(createPiRequest({ userId: 'u1', brand: 'goapply', kind: 'access' }, deps)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'pi_request_already_open', requestId: row.id },
    });
    await createPiRequest({ userId: 'u1', brand: 'goapply', kind: 'correction' }, deps);
    expect(await listUserPiRequests('u1', deps)).toHaveLength(2);
  });

  it('admin: overdue filter, handling notes, closing sets closedAt', async () => {
    const db = fake();
    const early = { db: db as unknown as PiRequestDb, now: () => new Date('2026-09-01T00:00:00Z') };
    const old = await createPiRequest({ userId: 'u1', brand: 'roboapply', kind: 'deletion' }, early);
    await createPiRequest({ userId: 'u2', brand: 'roboapply', kind: 'access' }, { db: db as unknown as PiRequestDb, now: () => now });
    const deps = { db: db as unknown as PiRequestDb, now: () => now };
    const overdue = await adminListPiRequests({ overdue: true }, deps);
    expect(overdue.items.map((i) => i.id)).toEqual([old.id]);
    expect(overdue.items[0]!.overdue).toBe(true);
    const updated = await adminUpdatePiRequest(old.id, { status: 'done', note: 'Deleted via #danger flow' }, { id: 'admin1' }, deps);
    expect(updated.status).toBe('done');
    expect(updated.resolvedAt).toBe(now.toISOString());
    expect(updated.handlingNotes).toEqual([{ at: now.toISOString(), by: 'admin1', note: 'Deleted via #danger flow' }]);
    await expect(adminUpdatePiRequest('missing', { note: 'x' }, { id: 'a' }, deps)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a finished export is downloadable until it expires or is swept', () => {
    const base = {
      id: 'r1',
      brand: 'roboapply',
      userId: 'u1',
      kind: 'copy',
      status: 'done',
      dueAt: now,
      createdAt: now,
      closedAt: now,
      detail: { export: { provider: 'local', key: 'k', bytes: 10, expiresAt: '2026-10-19T09:00:00.000Z' } },
    };
    expect(toPiRequestView(base, now).download).toEqual({ expiresAt: '2026-10-19T09:00:00.000Z', bytes: 10 });
    expect(toPiRequestView(base, new Date('2026-10-20T00:00:00Z')).download).toBeNull();
    expect(toPiRequestView({ ...base, detail: { export: { ...base.detail.export, purgedAt: 'x' } } }, now).download).toBeNull();
  });
});

// ── AI labels ──────────────────────────────────────────────────────────────

describe('aiLabel', () => {
  it('implicit label carries the GB 45438 element set and the IPTC source type', () => {
    const label = implicitLabelMetadata({ contentId: 'GA-1', provider: 'deepseek', brand: 'goapply', generatedAt: new Date('2026-10-10T00:00:00Z') });
    expect(Object.keys(label.pdfInfo).sort()).toEqual([...IMPLICIT_LABEL_KEYS.pdfInfo].sort());
    expect(Object.keys(label.docxCustomProperties).sort()).toEqual([...IMPLICIT_LABEL_KEYS.docx].sort());
    const aigc = JSON.parse(label.pdfInfo.AIGC!);
    expect(Object.keys(aigc)).toEqual(['Label', 'ContentProducer', 'ProduceID', 'ReservedCode1', 'ContentPropagator', 'PropagateID', 'ReservedCode2']);
    expect(aigc).toMatchObject({ Label: '1', ContentProducer: 'GoApply', ProduceID: 'GA-1' });
    expect(label).toMatchObject({ aiGenerated: true, provider: 'deepseek', producer: 'GoApply', brand: 'goapply', contentId: 'GA-1', generatedAt: '2026-10-10T00:00:00.000Z' });
    expect(label.pdfInfo.DigitalSourceType).toBe(IPTC_TRAINED_ALGORITHMIC);
    expect(label.xmp).toContain('Iptc4xmpExt:DigitalSourceType');
    expect(label.xmp).toContain('&quot;Label&quot;:&quot;1&quot;');
  });

  it('RoboApply exports get the same machine-readable keys; user-edited text is composite', () => {
    const label = runWithBrand('roboapply', () => implicitLabelMetadata({ contentId: 'RA-1', provider: 'openrouter', userEdited: true }));
    expect(label.brand).toBe('roboapply');
    expect(label.producer).toBe('RoboApply');
    expect(label.docxCustomProperties.DigitalSourceType).toBe(IPTC_COMPOSITE_ALGORITHMIC);
    expect(label.docxCustomProperties.AIGenerated).toBe('true');
  });

  it('content ids carry no user data', () => {
    expect(newAiContentId('goapply')).toMatch(/^GA-[0-9a-f]{24}$/);
    expect(newAiContentId('roboapply')).toMatch(/^RA-[0-9a-f]{24}$/);
  });

  it('explicit footer line per locale, on only for GoApply with the env switch', () => {
    expect(explicitFooterLine('zh')).toContain('人工智能辅助生成');
    expect(explicitFooterLine('zh-TW')).toContain('人工智慧');
    expect(explicitFooterLine('ja')).toBe(explicitFooterLine('en'));
    expect(explicitLabelEnabled('goapply', { CN_AI_EXPORT_EXPLICIT_LABEL: 'true' })).toBe(true);
    expect(explicitLabelEnabled('goapply', {})).toBe(false);
    expect(explicitLabelEnabled('roboapply', { CN_AI_EXPORT_EXPLICIT_LABEL: 'true' })).toBe(false);
  });

  it('logs a label row on GoApply only', async () => {
    const db = createFakePrisma();
    const deps = { db: db as unknown as AiLabelDb, env: { CN_AI_EXPORT_EXPLICIT_LABEL: 'on' } };
    expect(await logAiContentLabel({ userId: 'u1', contentId: 'GA-1', kind: 'resume', provider: 'deepseek', brand: 'goapply' }, deps)).toBe(true);
    expect(await logAiContentLabel({ userId: 'u1', contentId: 'RA-1', kind: 'resume', provider: 'x', brand: 'roboapply' }, deps)).toBe(false);
    expect(db.$rows('rAAiContentLabelLog')).toEqual([
      expect.objectContaining({ brand: 'goapply', userId: 'u1', artifactType: 'resume', labelMode: 'explicit', contentId: 'GA-1', artifactId: null }),
    ]);
  });
});

// ── explainMatch (PIPL Art. 24) ────────────────────────────────────────────

describe('explainMatch', () => {
  const dims: ExplainDimension[] = [
    { key: 'title_level', weight: 35, score: 90, status: 'scored', evidence: [{ text: 'Senior Data Analyst, 5 years', source: 'resume' }] },
    { key: 'skills', weight: 30, score: 70, status: 'scored', evidence: [{ text: 'SQL and Python', source: 'posting' }] },
    { key: 'industry', weight: 15, score: 30, status: 'scored' },
    { key: 'logistics', weight: 10, score: null, status: 'not_stated' },
    { key: 'career_path', weight: 10, score: 65, status: 'scored', evidence: [{ text: 'x'.repeat(300), source: 'resume' }] },
  ];

  it('non-personalised: no reasons, no score, says how it is sorted; GoApply says how to turn it on', () => {
    const e = explainMatch({ market: 'cn', personalized: false, score: 88, dimensions: dims });
    expect(e.mode).toBe('non_personalized');
    expect(e.reasons).toEqual([]);
    expect(e.gaps).toEqual([]);
    expect(e.headline.key).toBe('legal.explain.headline.nonPersonalized');
    expect(e.notices.map((n) => n.key)).toContain('legal.explain.notice.turnOn');
  });

  it('personalised: strongest weighted reasons first, gaps and not-stated, mandatory notices', () => {
    const e = explainMatch({ market: 'cn', personalized: true, score: 82, kind: 'pre', dimensions: dims, skills: { aligned: ['SQL'], missing: ['dbt', 'Airflow', 'Looker', 'Spark'] } });
    expect(e.headline).toEqual({ key: 'legal.explain.headline.personalized', params: { tier: 'great' } });
    expect(e.reasons.map((r) => r.key)).toEqual(['legal.explain.reason.title_level', 'legal.explain.reason.skills', 'legal.explain.reason.career_path']);
    expect(String(e.reasons[2]!.params!.evidence).length).toBeLessThanOrEqual(120);
    expect(e.gaps.map((g) => g.key)).toEqual(['legal.explain.gap.industry', 'legal.explain.notCompared.logistics', 'legal.explain.gap.skillsMissing']);
    expect(e.gaps[2]!.params).toEqual({ skills: 'dbt, Airflow, Looker' });
    expect(e.notices.map((n) => n.key)).toEqual([
      'legal.explain.notice.notHiringChance',
      'legal.explain.notice.quickEstimate',
      'legal.explain.notice.factors',
      'legal.explain.notice.turnOff',
    ]);
  });

  it('never invents a reason without a scored dimension; RoboApply has no opt-out notice', () => {
    const e = explainMatch({ market: 'intl', personalized: true });
    expect(e.reasons).toEqual([]);
    expect(e.headline.key).toBe('legal.explain.headline.personalizedNoScore');
    expect(e.notices.map((n) => n.key)).not.toContain('legal.explain.notice.turnOff');
    expect(e.notices[0]!.key).toBe('legal.explain.notice.notHiringChance');
  });

  // Review finding (M1 gate): the headline computed its own tier from the score with the DEFAULT thresholds,
  // while the card shows the tier of the fit (kept by hysteresis for a recomputed AI row, or cut at the
  // admin's thresholds). A card "78 / Great fit" then opened to "Why this job: a good fit".
  it('the headline names the tier the card shows when the caller passes it, and computes one only without it', () => {
    const base = { market: 'intl' as const, personalized: true, kind: 'ai' as const, dimensions: dims };
    expect(explainMatch({ ...base, score: 78 }).headline).toEqual({ key: 'legal.explain.headline.personalized', params: { tier: 'good' } });
    expect(explainMatch({ ...base, score: 78, tier: 'great' }).headline).toEqual({ key: 'legal.explain.headline.personalized', params: { tier: 'great' } });
    expect(explainMatch({ ...base, score: 81, tier: 'good' }).headline.params).toEqual({ tier: 'good' });
    // No tier known (null) falls back to the score; no score and no tier is the no-score headline.
    expect(explainMatch({ ...base, score: 81, tier: null }).headline.params).toEqual({ tier: 'great' });
    expect(explainMatch({ ...base, tier: 'great' }).headline.key).toBe('legal.explain.headline.personalizedNoScore');
  });

  it('emits only known keys (all present in the legal bundle)', async () => {
    // The `legal` strings are in the English web bundle (WP-91 merged them out of i18n/staging); a key
    // added since (`legal.explain.notCompared.*`, M1 gate) is in i18n/staging/legal.en.json until the i18n pass.
    const { default: bundle } = await import('../../../../i18n/messages/en.json', { with: { type: 'json' } });
    const { default: staged } = await import('../../../../i18n/staging/legal.en.json', { with: { type: 'json' } });
    const read = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
    const get = (path: string) => read(staged, path) ?? read(bundle, path);
    for (const key of EXPLAIN_KEYS) expect(typeof get(key), key).toBe('string');
    const e = explainMatch({ market: 'cn', personalized: true, score: 50, kind: 'ai', dimensions: dims, skills: { aligned: ['a'], missing: ['b'] } });
    for (const l of [e.headline, ...e.reasons, ...e.gaps, ...e.notices]) expect(EXPLAIN_KEYS).toContain(l.key);
  });

  // Estimate v2: a part is `not_stated` as often because the PERSON's side is missing (no role
  // evidence gives title_level null for a student on every card) as because the posting's is.
  // explainMatch does not know which side, so the sentence may not blame the posting (D3; on
  // GoApply this text is the PIPL Art. 24 explanation). The three parts get keys of their own
  // (`notCompared`): rewording the old keys in staging would change English only, and the
  // translated bundles would keep "the posting does not say" until the i18n pass. `skills` stays:
  // that part is not stated only when the posting lists no skill.
  it('a not-compared role, industry or logistics part never says "the posting does not say" (the missing side may be the person\'s)', async () => {
    const load = async (file: string) => (await import(`../../../../i18n/${file}`, { with: { type: 'json' } })).default as Record<string, unknown>;
    const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
    const [en, zh, stagedEn, stagedZh] = await Promise.all([load('messages/en.json'), load('messages/zh.json'), load('staging/legal.en.json'), load('staging/legal.zh.json')]);
    for (const part of ['title_level', 'industry', 'logistics']) {
      const key = `legal.explain.notCompared.${part}`;
      const english = (at(stagedEn, key) ?? at(en, key)) as string;
      const chinese = (at(stagedZh, key) ?? at(zh, key)) as string;
      expect(english, key).toMatch(/^Not enough to compare /);
      expect(english, key).not.toMatch(/posting|does not say/i);
      expect(chinese, key).toMatch(/^信息不足，无法比较/);
      expect(chinese, key).not.toMatch(/职位描述|没有说明/);
      expect(EXPLAIN_KEYS).toContain(key);
      // The old key says "The posting does not say …" in every translated bundle: never emitted for these parts.
      expect(EXPLAIN_KEYS).not.toContain(`legal.explain.notStated.${part}`);
    }
    expect(EXPLAIN_KEYS).toContain('legal.explain.notStated.skills');
    // The case: a person with no role evidence against a posting that states its level, industry and location.
    const e = explainMatch({
      market: 'cn',
      personalized: true,
      score: 60,
      kind: 'pre',
      dimensions: [
        { key: 'title_level', weight: 0.25, score: null, status: 'not_stated' },
        { key: 'skills', weight: 0.3, score: 100, status: 'scored' },
        { key: 'industry', weight: 0.15, score: null, status: 'not_stated' },
        { key: 'logistics', weight: 0.15, score: null, status: 'not_stated' },
      ] as ExplainDimension[],
    });
    expect(e.gaps.map((g) => g.key)).toEqual(['legal.explain.notCompared.title_level', 'legal.explain.notCompared.industry', 'legal.explain.notCompared.logistics']);
  });
});

// ── Disclosures and the legal footer ───────────────────────────────────────

describe('disclosures', () => {
  it('parses model ids and the CN filing JSON', () => {
    expect(parseModelId('openrouter/google/gemini-3-flash', null)).toEqual({ vendor: 'openrouter', model: 'google/gemini-3-flash' });
    expect(parseModelId('deepseek-chat', 'deepseek')).toEqual({ vendor: 'deepseek', model: 'deepseek-chat' });
    expect(parseGenaiDisclosures('not json')).toEqual([]);
    expect(parseGenaiDisclosures('[{"model":"deepseek-chat","vendor":"deepseek","filingNo":" Beijing-1 "},{"model":1}]')).toEqual([
      { model: 'deepseek-chat', vendor: 'deepseek', filingNo: 'Beijing-1' },
    ]);
  });

  it('GoApply models: the CN_ override when it is set, else the shared model (D5); RoboApply never reads a CN_ value', () => {
    const env = { LLM_MODEL: 'openrouter/x/y', CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat', CN_GENAI_DISCLOSURES: '[{"model":"deepseek-chat","vendor":"deepseek","filingNo":"F-1"}]' };
    expect(configuredModels(goapply, env)).toEqual([{ task: 'default', vendor: 'deepseek', model: 'deepseek-chat', region: 'CN', filingNo: 'F-1', source: 'own' }]);
    expect(configuredModels(roboapply, env)).toEqual([{ task: 'default', vendor: 'openrouter', model: 'x/y', region: 'US', filingNo: null, source: 'shared' }]);
    expect(configuredModels(goapply, {})).toEqual([]);
    // No CN model at all: GoApply runs on the shared stack, and the disclosure names that stack.
    const shared = { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openai/gpt-5', LLM_COPILOT_MODEL: 'openrouter/anthropic/claude-x' };
    expect(configuredModels(goapply, shared)).toEqual([
      { task: 'default', vendor: 'openai', model: 'gpt-5', region: 'US', filingNo: null, source: 'shared' },
      { task: 'assistant', vendor: 'openrouter', model: 'anthropic/claude-x', region: 'US', filingNo: null, source: 'shared' },
    ]);
    expect(configuredModels(goapply, shared).map(({ source: _s, ...m }) => m)).toEqual(configuredModels(roboapply, shared).map(({ source: _s, ...m }) => m));
    // Per key: its own default model, the shared vision model. Each row says where it comes from.
    const mixed = { ...shared, CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat', LLM_VISION_MODEL: 'openrouter/google/gemini-x' };
    expect(configuredModels(goapply, mixed).map((m) => [m.task, m.vendor, m.source])).toEqual([
      ['default', 'deepseek', 'own'],
      ['assistant', 'openrouter', 'shared'],
      ['vision', 'openrouter', 'shared'],
    ]);
    // A bare model id takes the brand's provider: the CN one when set, else the shared one.
    expect(configuredModels(goapply, { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'gpt-5' })[0]).toMatchObject({ vendor: 'openrouter', model: 'gpt-5' });
  });

  it('mixed stack: a bare id of the shared stack is served by the SHARED provider, never disclosed as GoApply\'s own (mainland) vendor', () => {
    // GoApply has its own provider and default model; the vision model is left to the shared stack, as a bare id.
    const env = {
      DEPLOY_REGION: 'cn-mainland',
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-5',
      LLM_VISION_MODEL: 'gpt-5-vision',
      CN_LLM_PROVIDER: 'deepseek',
      CN_LLM_MODEL: 'deepseek-chat',
    };
    expect(configuredModels(goapply, env)).toEqual([
      { task: 'default', vendor: 'deepseek', model: 'deepseek-chat', region: 'CN', filingNo: null, source: 'own' },
      { task: 'vision', vendor: 'openai', model: 'gpt-5-vision', region: 'US', filingNo: null, source: 'shared' },
    ]);
    expect(aiLeavesMainland(goapply, env)).toBe(true);
    expect(crossBorderConsentApplies(goapply, env)).toBe(true);
    // The signed sentences and the processor list name the vendor the request really goes to.
    expect(aiPlaceSentence(goapply, env, 'zh')).toBe('AI 请求会发送到这些 AI 服务：deepseek（中国大陆）、openai（美国）。');
    expect(aiPlaceSentence(goapply, env, 'en')).toBe('AI requests are sent to these AI services: deepseek (mainland China); openai (United States). ');
    expect(offshoreProcessors(goapply, env).map((p) => `${p.purpose}:${p.name}:${p.country}`)).toEqual(['ai_models:openai:US']);
    expect(buildLegalFooter(goapply, env).aiModels.map((m) => `${m.vendor}/${m.model}`)).toEqual(['deepseek/deepseek-chat', 'openai/gpt-5-vision']);
    // A bare id GoApply set for itself still takes GoApply's provider; with no provider of its own, the shared one.
    expect(configuredModels(goapply, { ...env, CN_LLM_VISION_MODEL: 'deepseek-vl' }).map((m) => [m.task, m.vendor, m.source])).toEqual([
      ['default', 'deepseek', 'own'],
      ['vision', 'deepseek', 'own'],
    ]);
    expect(configuredModels(goapply, { LLM_PROVIDER: 'openai', CN_LLM_MODEL: 'gpt-5-mini' })).toEqual([
      { task: 'default', vendor: 'openai', model: 'gpt-5-mini', region: 'US', filingNo: null, source: 'own' },
    ]);
    // RoboApply's rows are the shared stack's, whatever GoApply sets.
    expect(configuredModels(roboapply, env).map((m) => [m.task, m.vendor, m.region])).toEqual([
      ['default', 'openai', 'US'],
      ['vision', 'openai', 'US'],
    ]);
  });

  it('a row is placed with a mainland vendor only when the request really goes there: `qwen/…` and `moonshotai/…` on a gateway name the gateway', () => {
    // A gateway namespace that carries a mainland vendor's name, in either dialect.
    expect(parseModelId('moonshotai/kimi-k2', 'openrouter')).toEqual({ vendor: 'openrouter', model: 'moonshotai/kimi-k2' });
    expect(parseModelId('moonshotai/kimi-k2', 'openrouter', 'domestic_cn')).toEqual({ vendor: 'openrouter', model: 'moonshotai/kimi-k2' });
    // The real routes to the mainland keep their vendor: a routing prefix, an alias, a bare id on a mainland provider.
    expect(parseModelId('moonshot/kimi-k2', 'openrouter')).toEqual({ vendor: 'moonshot', model: 'kimi-k2' });
    expect(parseModelId('zhipu/glm-5', 'openrouter')).toEqual({ vendor: 'zhipu', model: 'glm-5' });
    expect(parseModelId('qwen-plus', 'dashscope')).toEqual({ vendor: 'dashscope', model: 'qwen-plus' });
    // Mode `direct`: a `vendor/model` id that pins no provider goes to OpenRouter.
    expect(parseModelId('moonshotai/kimi-k2', 'direct')).toEqual({ vendor: 'openrouter', model: 'moonshotai/kimi-k2' });
    // No provider mode at all in the domestic dialect: there is no route, so no vendor is named.
    expect(parseModelId('moonshotai/kimi-k2', null, 'domestic_cn')).toEqual({ vendor: 'unknown', model: 'moonshotai/kimi-k2' });
    // Vendors outside the mainland are named as before, gateway namespace or not.
    expect(parseModelId('x-ai/grok-4', 'openrouter')).toEqual({ vendor: 'x-ai', model: 'grok-4' });
    expect(parseModelId('openai/gpt-5', 'openrouter')).toEqual({ vendor: 'openai', model: 'gpt-5' });

    expect(parseModelId('qwen/qwen-plus', 'deepseek', 'domestic_cn')).toEqual({ vendor: 'qwen', model: 'qwen-plus' });
    expect(parseModelId('qwen/qwen3.8-flash', 'openrouter', 'global')).toEqual({ vendor: 'openrouter', model: 'qwen/qwen3.8-flash' });
    expect(parseModelId('qwen/qwen3.8-flash', null)).toEqual({ vendor: 'openrouter', model: 'qwen/qwen3.8-flash' });
    expect(parseModelId('qwen/qwen3.8-flash', 'direct')).toEqual({ vendor: 'openrouter', model: 'qwen/qwen3.8-flash' });
    // `dashscope/` is the unambiguous spelling of the mainland endpoint in both dialects.
    expect(parseModelId('dashscope/qwen-plus', 'openrouter', 'global')).toEqual({ vendor: 'dashscope', model: 'qwen-plus' });
    const shared = { DEPLOY_REGION: 'cn-mainland', LLM_PROVIDER: 'openrouter', LLM_MODEL: 'qwen/qwen3.8-flash' };
    // The shared selector goes to OpenRouter for both brands: disclosed as such, and it leaves the mainland.
    for (const brand of [goapply, roboapply]) {
      expect(configuredModels(brand, shared)).toEqual([{ task: 'default', vendor: 'openrouter', model: 'qwen/qwen3.8-flash', region: 'US', filingNo: null, source: 'shared' }]);
    }
    expect(aiLeavesMainland(goapply, shared)).toBe(true);
    // The same words set by GoApply for itself mean Alibaba's own endpoint.
    const own = { DEPLOY_REGION: 'cn-mainland', CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'qwen/qwen-plus' };
    expect(configuredModels(goapply, own)).toEqual([{ task: 'default', vendor: 'qwen', model: 'qwen-plus', region: 'CN', filingNo: null, source: 'own' }]);
    expect(aiLeavesMainland(goapply, own)).toBe(false);
  });

  it('behind the domestic-only wall a shared value that names no mainland vendor is not used, so it is not listed', () => {
    const env = {
      DEPLOY_REGION: 'cn-mainland',
      CN_LLM_DOMESTIC_ONLY: 'true',
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-5',
      LLM_VISION_MODEL: 'gpt-5-vision',
      LLM_ENRICH_MODEL: 'deepseek/deepseek-chat',
      // A gateway id that only carries a mainland vendor's name: it goes to the shared provider, so it is set aside too.
      LLM_WRITING_MODEL: 'moonshotai/kimi-k2',
      CN_LLM_PROVIDER: 'deepseek',
      CN_LLM_MODEL: 'deepseek-chat',
    };
    expect(configuredModels(goapply, env).map((m) => [m.task, m.vendor, m.model, m.source])).toEqual([
      ['default', 'deepseek', 'deepseek-chat', 'own'],
    ]);
    expect(aiLeavesMainland(goapply, env)).toBe(false);
    expect(aiPlaceSentence(goapply, env, 'en')).toBe('AI requests are sent only to AI services in mainland China. ');
    // A shared value that names a mainland vendor by itself is still a fallback behind the wall.
    expect(configuredModels(goapply, { ...env, CN_LLM_MODEL: undefined, LLM_MODEL: 'deepseek/deepseek-v4' }).map((m) => [m.task, m.vendor, m.model, m.source])).toEqual([
      ['default', 'deepseek', 'deepseek-v4', 'shared'],
      ['enrich', 'deepseek', 'deepseek-chat', 'shared'],
    ]);
    // RoboApply does not read the wall.
    expect(configuredModels(roboapply, env).map((m) => `${m.task}:${m.vendor}`)).toEqual(['default:openai', 'writing:openai', 'enrich:deepseek', 'vision:openai']);
  });

  it('processors are derived from configuration', () => {
    const d = buildDisclosures(goapply, { DATABASE_URL: 'postgres://u@ep-a.us-east-2.aws.neon.tech/db', VERCEL: '1', RESEND_API_KEY: 'k', CN_EMAIL_TRANSPORT: 'resend' });
    expect(d.processors).toEqual([
      { name: 'Neon', purpose: 'database', country: 'US', region: 'us-east-2' },
      { name: 'Vercel', purpose: 'hosting', country: 'US', region: null },
      { name: 'Resend', purpose: 'email', country: 'US', region: null },
    ]);
    expect(d.offshore).toBe(true);
    // The database country follows the parsed region; an unknown region is "Not listed", never assumed US.
    const neon = (url: string) => buildDisclosures(roboapply, { DATABASE_URL: url }).processors[0];
    expect(neon('postgres://u@ep-a.eu-central-1.aws.neon.tech/db')).toEqual({ name: 'Neon', purpose: 'database', country: 'DE', region: 'eu-central-1' });
    expect(neon('postgres://u@ep-a.ap-southeast-1.aws.neon.tech/db')).toMatchObject({ country: 'SG', region: 'ap-southeast-1' });
    expect(neon('postgres://u@ep-a.me-central-1.aws.neon.tech/db')).toMatchObject({ country: null, region: 'me-central-1' });
    expect(neon('postgres://u@ep-a.eastus2.azure.neon.tech/db')).toMatchObject({ country: null, region: null });
    expect(buildDisclosures(roboapply, {}).offshore).toBe(false);
  });
});

/** The shared stack of a deployment: what RoboApply runs on, and GoApply's fallback (D5). */
const SHARED_STACK = {
  DATABASE_URL: 'postgres://u@ep-a.us-east-2.aws.neon.tech/db',
  VERCEL: '1',
  RESEND_API_KEY: 're_k',
  LIVEKIT_URL: 'wss://proj.livekit.cloud',
  LIVEKIT_API_KEY: 'lk',
  LIVEKIT_API_SECRET: 'ls',
  DEEPGRAM_API_KEY: 'dg',
  CARTESIA_API_KEY: 'ct',
  S3_BUCKET: 'shared',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_ACCESS_KEY_ID: 'i',
  S3_SECRET_ACCESS_KEY: 's',
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  VAPID_SUBJECT: 'mailto:ops@example.com',
  LLM_PROVIDER: 'openrouter',
  LLM_MODEL: 'openai/gpt-5',
  STRIPE_SECRET_KEY: 'sk_test_x',
};

/** A complete stack of GoApply's own on a mainland deployment. */
const FULL_CN_STACK = {
  DEPLOY_REGION: 'cn-mainland',
  DATABASE_URL: 'postgresql://u:p@10.0.0.12:5432/goapply',
  CN_LLM_PROVIDER: 'deepseek',
  CN_LLM_MODEL: 'deepseek-chat',
  CN_LIVEKIT_URL: 'wss://rtc.goapply.example.cn',
  CN_LIVEKIT_API_KEY: 'lk',
  CN_LIVEKIT_API_SECRET: 'ls',
  CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer',
  CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/cosyvoice',
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_S3_BUCKET: 'cn',
  CN_S3_ACCESS_KEY_ID: 'i',
  CN_S3_SECRET_ACCESS_KEY: 's',
  CN_VAPID_PUBLIC_KEY: 'pub',
  CN_VAPID_PRIVATE_KEY: 'priv',
  CN_VAPID_SUBJECT: 'mailto:ops@goapply.example.cn',
  CN_EMAIL_TRANSPORT: 'aliyun_dm',
  ALIYUN_DM_ACCESS_KEY_ID: 'dm',
  ALIYUN_DM_ACCESS_KEY_SECRET: 'dms',
  ALIYUN_DM_ACCOUNT_NAME: 'noreply@goapply.example.cn',
};

describe('disclosures name the stack GoApply really uses (D5; G47)', () => {
  const rows = (brand: typeof goapply, env: Record<string, string>) => configuredProcessors(brand, env).map((p) => `${p.purpose}:${p.name}`);

  it('with the shared-only env GoApply lists the same processors as RoboApply (minus Stripe, its market rail), nothing else', () => {
    const robo = rows(roboapply, SHARED_STACK);
    expect(robo).toEqual([
      'database:Neon',
      'hosting:Vercel',
      'email:Resend',
      'voice:LiveKit Cloud',
      'speech:Deepgram',
      'speech:Cartesia',
      'payments:Stripe',
      'storage:Object storage',
      `push:${WEB_PUSH_PROCESSOR_NAME}`,
      'ai_models:openai',
    ]);
    const go = rows(goapply, SHARED_STACK);
    // Email follows the transport GoApply really sends through (platform/email `transportNameFor`):
    // Resend whenever that is its transport, never listed when no email is sent.
    const goEmail = transportNameFor(goapply, SHARED_STACK) === 'resend' ? ['email:Resend'] : [];
    expect(go).toEqual(robo.filter((r) => r !== 'payments:Stripe' && r !== 'email:Resend').flatMap((r) => (r === 'voice:LiveKit Cloud' ? [...goEmail, r] : [r])));
    // An explicit Resend transport is listed whatever the default is.
    expect(rows(goapply, { ...SHARED_STACK, CN_EMAIL_TRANSPORT: 'resend' })).toContain('email:Resend');
    expect(rows(goapply, { ...SHARED_STACK, CN_EMAIL_TRANSPORT: 'none' })).not.toContain('email:Resend');
    // Countries are the same facts too: the shared bucket has no country we can read.
    expect(configuredProcessors(goapply, SHARED_STACK).find((p) => p.purpose === 'storage')).toEqual({ name: 'Object storage', purpose: 'storage', country: null, region: null });
  });

  it('nothing unconfigured is listed: an empty env lists no processor for either brand', () => {
    expect(configuredProcessors(goapply, {})).toEqual([]);
    expect(configuredProcessors(roboapply, {})).toEqual([]);
    // A key without its group, or a transport without its key, is not a processor.
    expect(rows(goapply, { VAPID_PUBLIC_KEY: 'pub' })).toEqual([]);
    expect(rows(goapply, { CN_EMAIL_TRANSPORT: 'resend' })).toEqual([]);
    expect(rows(goapply, { CN_EMAIL_TRANSPORT: 'aliyun_dm' })).toEqual([]);
    expect(rows(goapply, { ALIPAY_API_URL: 'https://pay.example' })).toEqual([]);
  });

  it('GoApply-only processors appear when they are configured, and its own groups replace the shared ones', () => {
    const go = rows(goapply, { ...SHARED_STACK, ...FULL_CN_STACK, ALIPAY_CALLBACK_SECRET: 'cb', CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green', ALIYUN_GREEN_ACCESS_KEY_ID: 'ak', ALIYUN_GREEN_ACCESS_KEY_SECRET: 'sk' });
    expect(go).toEqual([
      'hosting:Vercel',
      'email:Aliyun DirectMail',
      // Its own media plane, not on LiveKit Cloud.
      'voice:LiveKit',
      // Its own speech pair: the shared speech vendors are not used.
      'payments:Alipay',
      'storage:Object storage (CN)',
      `push:${WEB_PUSH_PROCESSOR_NAME}`,
      'content_safety:Aliyun Content Moderation',
      'ai_models:deepseek',
    ]);
    // The kill switch stops the rail, so it is not a processor.
    expect(rows(goapply, { ALIPAY_CALLBACK_SECRET: 'cb', CN_PAYMENTS_ENABLED: 'false' })).toEqual([]);
    // RoboApply never lists a GoApply provider, whatever CN_ values exist.
    const robo = rows(roboapply, { ...SHARED_STACK, ...FULL_CN_STACK, ALIPAY_CALLBACK_SECRET: 'cb' });
    for (const cnOnly of ['email:Aliyun DirectMail', 'payments:Alipay', 'storage:Object storage (CN)', 'ai_models:deepseek', 'voice:LiveKit']) expect(robo).not.toContain(cnOnly);
  });

  it('a CN bucket is called "(CN)" only when its endpoint is mainland object storage', () => {
    const own = (endpoint: string) => configuredProcessors(goapply, { CN_S3_BUCKET: 'cn', CN_S3_ENDPOINT: endpoint, CN_S3_ACCESS_KEY_ID: 'i', CN_S3_SECRET_ACCESS_KEY: 's' }).find((p) => p.purpose === 'storage');
    expect(own('https://oss-cn-shanghai.aliyuncs.com')).toEqual({ name: 'Object storage (CN)', purpose: 'storage', country: 'CN', region: null });
    expect(own('https://s3.us-east-1.amazonaws.com')).toEqual({ name: 'Object storage', purpose: 'storage', country: null, region: null });
    expect(own('https://oss-cn-hongkong.aliyuncs.com')).toEqual({ name: 'Object storage', purpose: 'storage', country: null, region: null });
  });

  it('the AI endpoint rule: open by default, mainland_only only behind the domestic-only wall; RoboApply is always no_mainland', () => {
    expect(llmEndpointRule(goapply, {})).toBe('open');
    expect(llmEndpointRule(goapply, SHARED_STACK)).toBe('open');
    // GoApply's own provider alone is not the wall: other routes are still reachable.
    expect(llmEndpointRule(goapply, FULL_CN_STACK)).toBe('open');
    expect(llmEndpointRule(goapply, { ...FULL_CN_STACK, CN_LLM_DOMESTIC_ONLY: 'true' })).toBe('mainland_only');
    expect(llmEndpointRule(goapply, { ...FULL_CN_STACK, CN_RESIDENCY_STRICT: 'true' })).toBe('mainland_only');
    // The wall with no domestic model: only mainland endpoints are allowed, so that is still what is said.
    expect(llmEndpointRule(goapply, { CN_LLM_DOMESTIC_ONLY: 'true' })).toBe('mainland_only');
    for (const env of [{}, SHARED_STACK, { CN_LLM_DOMESTIC_ONLY: 'true' }, { CN_RESIDENCY_STRICT: 'true' }]) expect(llmEndpointRule(roboapply, env)).toBe('no_mainland');
  });

  it('the cross-border flag: whenever personal information leaves the mainland on this deployment, and only then', () => {
    // Offshore deployment: always.
    expect(buildDisclosures(goapply, {}).offshore).toBe(true);
    expect(buildDisclosures(goapply, { ...FULL_CN_STACK, DEPLOY_REGION: '' }).offshore).toBe(true);
    // Mainland deployment on the shared stack (in whole or in part): yes.
    expect(buildDisclosures(goapply, { DEPLOY_REGION: 'cn-mainland' }).offshore).toBe(true);
    expect(buildDisclosures(goapply, { DEPLOY_REGION: 'cn-mainland', ...SHARED_STACK }).offshore).toBe(true);
    expect(buildDisclosures(goapply, { ...FULL_CN_STACK, CN_S3_BUCKET: '' }).offshore).toBe(true);
    expect(buildDisclosures(goapply, { ...FULL_CN_STACK, CN_EMAIL_TRANSPORT: 'resend' }).offshore).toBe(true);
    // Mainland deployment with a complete stack of its own: no.
    expect(buildDisclosures(goapply, FULL_CN_STACK).offshore).toBe(false);
    expect(buildDisclosures(goapply, { ...FULL_CN_STACK, CN_LLM_DOMESTIC_ONLY: 'true' }).offshore).toBe(false);
    // ...unless its own model provider is itself abroad (the env predicate alone cannot see that).
    const ownButAbroad = { ...FULL_CN_STACK, CN_LLM_PROVIDER: 'openrouter', CN_LLM_MODEL: 'openai/gpt-5' };
    expect(aiLeavesMainland(goapply, ownButAbroad)).toBe(true);
    expect(crossBorderConsentApplies(goapply, ownButAbroad)).toBe(true);
    expect(buildDisclosures(goapply, ownButAbroad).offshore).toBe(true);
    // Behind the wall that route is refused, so nothing leaves.
    expect(aiLeavesMainland(goapply, { ...ownButAbroad, CN_LLM_DOMESTIC_ONLY: 'true' })).toBe(false);
    // A vendor whose country we cannot name is not assumed to be in the mainland.
    expect(aiLeavesMainland(goapply, { ...FULL_CN_STACK, CN_LLM_PROVIDER: 'newapi', CN_LLM_MODEL: 'house-model' })).toBe(true);
    // RoboApply: never.
    for (const env of [{}, SHARED_STACK, FULL_CN_STACK]) {
      expect(buildDisclosures(roboapply, env).offshore).toBe(false);
      expect(aiLeavesMainland(roboapply, env)).toBe(false);
    }
  });
});

describe('disclosures rendered from the code that enforces them (WP-93)', () => {
  const ALIYUN = { CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green', ALIYUN_GREEN_ACCESS_KEY_ID: 'ak', ALIYUN_GREEN_ACCESS_KEY_SECRET: 'sk' };

  it('GoApply lists Aliyun Content Moderation (mainland) only when it is the configured, usable filter', () => {
    const listed = buildDisclosures(goapply, ALIYUN).processors.filter((p) => p.purpose === 'content_safety');
    expect(listed).toEqual([{ name: 'Aliyun Content Moderation', purpose: 'content_safety', country: 'CN', region: null }]);
    expect(buildDisclosures(goapply, { ...ALIYUN, ALIYUN_GREEN_REGION: 'cn-shanghai' }).processors.find((p) => p.purpose === 'content_safety')).toMatchObject({
      country: 'CN',
      region: 'cn-shanghai',
    });
    // The built-in keyword filter sends nothing out; a half-configured or offshore Aliyun filter is not claimed.
    const none = (env: Record<string, string>) => buildDisclosures(goapply, env).processors.some((p) => p.purpose === 'content_safety');
    expect(none({})).toBe(false);
    expect(none({ CN_CONTENT_SAFETY_PROVIDER: 'keyword_only' })).toBe(false);
    expect(none({ CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green' })).toBe(false);
    expect(none({ ...ALIYUN, ALIYUN_GREEN_REGION: 'ap-southeast-1' })).toBe(false);
    // RoboApply has no such processor, whatever the CN variables say.
    expect(buildDisclosures(roboapply, ALIYUN).processors.some((p) => p.purpose === 'content_safety')).toBe(false);
    expect(serverPurposes()).toContain('content_safety');
  });

  it('processing facts are exactly residencySummary(brand)', () => {
    const cases: Array<[typeof goapply, Record<string, string>]> = [
      [roboapply, {}],
      [roboapply, { S3_BUCKET: 'b', S3_ENDPOINT: 'https://r2.example.test', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' }],
      [goapply, {}],
      [goapply, { DEPLOY_REGION: 'cn-mainland' }],
      [goapply, { DEPLOY_REGION: 'cn-mainland', CN_S3_BUCKET: 'cn', CN_S3_ENDPOINT: 'https://oss-cn-shanghai.example.test', CN_S3_ACCESS_KEY_ID: 'a', CN_S3_SECRET_ACCESS_KEY: 's' }],
      [goapply, { S3_BUCKET: 'b', S3_ENDPOINT: 'https://r2.example.test', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' }],
      [goapply, { CN_STORAGE_MODE: 'redact' }],
      [goapply, { CN_STORAGE_MODE: 'discard' }],
      [goapply, { DEPLOY_REGION: 'cn-mainland', CN_RESIDENCY_STRICT: 'true' }],
    ];
    for (const [brand, env] of cases) {
      const r = residencySummary(brand, env);
      expect(processingFacts(brand, env), `${brand.id} ${JSON.stringify(env)}`).toEqual({
        region: r.region,
        stage: r.stage,
        originalFiles: r.originalFiles,
        storage: r.storage,
        resumeParsing: r.resumeParsing,
        resumeParser: r.resumeParsing === 'gohire_mainland' ? 'GoHire' : null,
        redactedBeforeStorage: [...r.redactedBeforeStorage],
        imagesDiscarded: r.imagesDiscarded,
      });
      expect(buildDisclosures(brand, env).processing).toEqual(processingFacts(brand, env));
    }
    // The outside parser is named by the server only when it is really in use.
    expect(processingFacts(goapply, { GOHIRE_API_KEY: 'k' })).toMatchObject({ resumeParsing: 'gohire_mainland', resumeParser: 'GoHire' });
    expect(processingFacts(roboapply, { GOHIRE_API_KEY: 'k' })).toMatchObject({ resumeParsing: 'local', resumeParser: null });
    expect(processingFacts(roboapply, { GOHIRE_API_KEY: 'k', GOHIRE_PARSE_BRANDS: 'roboapply,goapply' })).toMatchObject({ resumeParsing: 'gohire_mainland', resumeParser: 'GoHire' });
    // GoApply by default (D5): files kept on the shared store, nothing redacted or discarded, exactly like RoboApply.
    expect(processingFacts(goapply, {})).toMatchObject({ region: 'offshore', stage: 'cn0', originalFiles: 'kept', storage: 'shared', redactedBeforeStorage: [], imagesDiscarded: false });
    expect(processingFacts(roboapply, {})).toMatchObject({ region: 'offshore', stage: 'intl', originalFiles: 'kept', storage: 'shared', redactedBeforeStorage: [], imagesDiscarded: false });
    // The opt-in modes are stated as they are: the notice cannot claim more, or less, than the deployment does.
    expect(processingFacts(goapply, { CN_STORAGE_MODE: 'discard' })).toMatchObject({ originalFiles: 'not_kept', imagesDiscarded: true });
    expect(processingFacts(goapply, { CN_STORAGE_MODE: 'discard' }).redactedBeforeStorage.length).toBeGreaterThan(0);
    expect(processingFacts(goapply, { CN_STORAGE_MODE: 'redact' })).toMatchObject({ originalFiles: 'kept', imagesDiscarded: false });
    expect(processingFacts(goapply, { CN_STORAGE_MODE: 'redact' }).redactedBeforeStorage.length).toBeGreaterThan(0);
    expect(processingFacts(goapply, { CN_RESIDENCY_STRICT: 'true' })).toMatchObject({ originalFiles: 'unavailable' });
  });

  it('the public response never carries the storage bucket endpoint (for some stores the host holds the account id)', () => {
    const R2 = { S3_BUCKET: 'b', S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' };
    const OSS = {
      DEPLOY_REGION: 'cn-mainland',
      CN_S3_BUCKET: 'cn',
      CN_S3_ENDPOINT: 'https://oss-cn-shanghai.example.test',
      CN_S3_ACCESS_KEY_ID: 'a',
      CN_S3_SECRET_ACCESS_KEY: 's',
    };
    for (const [brand, env, host] of [
      [roboapply, R2, '0123456789abcdef'],
      [goapply, OSS, 'oss-cn-shanghai'],
    ] as const) {
      // The summary knows the host; the disclosure leaves it out.
      expect(residencySummary(brand, env).storageHost).toContain(host);
      const d = buildDisclosures(brand, env);
      expect(d.processing.originalFiles).toBe('kept');
      expect('storageHost' in d.processing).toBe(false);
      expect(JSON.stringify(d)).not.toContain(host);
      for (const zh of [true, false]) {
        const md = processingFactsMarkdown(d.processing, zh);
        expect(md).not.toContain(host);
        expect(md).toContain(zh ? '保存在我们自己的文件存储中。' : 'kept in our own file storage.');
      }
    }
  });

  it("'local' parsing is stated as what it is: no outside parser — never \"read on our own servers\"", () => {
    const local = processingFacts(roboapply, {});
    expect(local.resumeParsing).toBe('local');
    const en = processingFactsMarkdown(local, false);
    const zh = processingFactsMarkdown(processingFacts(goapply, {}), true);
    expect(en).toContain('not sent to a separate resume-parsing service');
    expect(en).toContain('it goes to an AI model provider');
    expect(zh).toContain('不会发送给单独的简历解析服务');
    expect(zh).toContain('AI 模型服务方');
    for (const md of [en, zh]) expect(md).not.toMatch(/own servers|自己的服务器/);
    // With the outside parser in use, the line names it from the server value.
    const viaParser = processingFacts(goapply, { GOHIRE_API_KEY: 'k' });
    expect(processingFactsMarkdown(viaParser, false)).toContain('done by the GoHire parsing service on servers in mainland China');
    expect(processingFactsMarkdown(viaParser, true)).toContain('由位于中国大陆服务器上的 GoHire 解析服务完成');
    // A response without a parser name states only the no-outside-parser fact.
    expect(processingFactsMarkdown({ ...viaParser, resumeParser: null }, false)).toContain('not sent to a separate resume-parsing service');
  });

  it('GoApply AI endpoints behind the domestic-only wall: only domestic providers on allowlisted hosts, and every listed route passes the egress policy', () => {
    for (const WALL of [{ CN_LLM_DOMESTIC_ONLY: 'true' }, { CN_RESIDENCY_STRICT: 'true' }]) {
      const f = llmEndpointFacts(goapply, WALL);
      expect(f.rule).toBe('mainland_only');
      expect(f.excludedUpstreams).toEqual([]);
      expect(f.mainlandHosts).toEqual([...MAINLAND_LLM_HOST_SUFFIXES]);
      expect(f.providers.length).toBeGreaterThanOrEqual(5);
      for (const p of f.providers) {
        expect(GOAPPLY_DIRECT_PROVIDERS as readonly string[], p.provider).toContain(p.provider);
        expect(p.host).toBe(hostOf(PROVIDER_DEFAULT_BASE_URLS[p.provider]));
        expect(isMainlandLlmHost(p.host)).toBe(true);
        expect(checkLlmEgress({ brand: goapply, provider: p.provider, env: WALL }).allowed, p.provider).toBe(true);
      }
      // No offshore provider is offered to GoApply behind the wall.
      for (const offshore of ['openai', 'openrouter', 'anthropic', 'google']) expect(f.providers.map((p) => p.provider)).not.toContain(offshore);
      // An ops-added domestic gateway host joins the allowlist.
      expect(llmEndpointFacts(goapply, { ...WALL, CN_LLM_DOMESTIC_HOSTS: 'llm.internal.example.cn' }).mainlandHosts).toContain('llm.internal.example.cn');
    }
  });

  it('GoApply AI endpoints by default (rule open): every provider it can reach, RoboApply\'s and the domestic ones; no host rule is claimed', () => {
    const f = llmEndpointFacts(goapply, {});
    expect(f.rule).toBe('open');
    // No host is allowed or refused by rule, so no list of hosts is published and no upstream is said to be excluded.
    expect(f.mainlandHosts).toEqual([]);
    expect(f.excludedUpstreams).toEqual([]);
    const listed = f.providers.map((p) => p.provider);
    // Everything RoboApply may use...
    for (const p of llmEndpointFacts(roboapply, {}).providers) expect(listed, p.provider).toContain(p.provider);
    for (const shared of ['openai', 'openrouter', 'anthropic']) expect(listed).toContain(shared);
    // ...plus the domestic providers behind the wall list.
    for (const p of llmEndpointFacts(goapply, { CN_LLM_DOMESTIC_ONLY: 'true' }).providers) expect(listed, p.provider).toContain(p.provider);
    for (const p of f.providers) {
      expect(p.host).toBe(hostOf(PROVIDER_DEFAULT_BASE_URLS[p.provider]));
      expect(p.host).not.toBe('localhost');
    }
    // One row per host.
    expect(new Set(f.providers.map((p) => p.host)).size).toBe(f.providers.length);
  });

  it('RoboApply AI endpoints: no mainland host is listed as usable; the refused hosts and upstreams are the policy lists', () => {
    const f = llmEndpointFacts(roboapply, {});
    expect(f.rule).toBe('no_mainland');
    expect(f.mainlandHosts).toEqual([...MAINLAND_LLM_HOST_SUFFIXES]);
    expect(f.excludedUpstreams).toEqual([...OPENROUTER_MAINLAND_UPSTREAMS]);
    expect(llmEndpointFacts(roboapply, { OPENROUTER_IGNORE_PROVIDERS: 'someone' }).excludedUpstreams).toEqual([...OPENROUTER_MAINLAND_UPSTREAMS, 'someone']);
    expect(f.providers.length).toBeGreaterThanOrEqual(4);
    for (const p of f.providers) {
      expect(p.host).toBe(hostOf(PROVIDER_DEFAULT_BASE_URLS[p.provider]));
      expect(isMainlandLlmHost(p.host), p.host).toBe(false);
      expect(p.host).not.toBe('localhost');
      expect(checkLlmEgress({ brand: roboapply, provider: p.provider, env: {} }).allowed, p.provider).toBe(true);
    }
    // Every mainland default host of the policy table is absent from the usable list and refused by the policy.
    const usable = new Set(f.providers.map((p) => p.host));
    for (const [provider, url] of Object.entries(PROVIDER_DEFAULT_BASE_URLS)) {
      const host = hostOf(url);
      if (!host || !isMainlandLlmHost(host)) continue;
      expect(usable.has(host), host).toBe(false);
      expect(checkLlmEgress({ brand: roboapply, provider, env: {} }).allowed, provider).toBe(false);
    }
    // One row per host (aliases such as google/gemini are not repeated).
    expect(new Set(f.providers.map((p) => p.host)).size).toBe(f.providers.length);
  });

  it('data attributions: every dataset whose licence requires credit, and only those', () => {
    const required = jobDataAttributions().filter((a) => a.attributionRequired);
    const shown = dataAttributions();
    expect(shown.map((a) => a.id)).toEqual(required.map((a) => a.source.id));
    expect(shown.length).toBeGreaterThanOrEqual(1);
    for (const a of shown) {
      const src = required.find((r) => r.source.id === a.id)!;
      expect(a).toMatchObject({ name: src.source.name, publisher: src.source.publisher, url: src.source.url, license: src.source.license, asOf: src.asOf });
      expect(a.license).toMatch(/CC BY/);
      expect(['job_locations', 'role_categories', 'agency_marking']).toContain(a.purpose);
    }
    expect(shown.find((a) => a.id === 'onet_soc_2019')).toMatchObject({ purpose: 'role_categories' });
    // Lists the team compiled itself need no credit and are not presented as third-party data.
    expect(shown.some((a) => /compiled by/i.test(a.name))).toBe(false);
    expect(buildDisclosures(goapply, {}).dataAttributions).toEqual(shown);
  });
});

function serverPurposes(): readonly string[] {
  return PROCESSOR_PURPOSES;
}

describe('legal footer (snapshot with and without env)', () => {
  it('without env: only links, no numbers, nothing pending', () => {
    const f = buildLegalFooter(goapply, {});
    expect(f).toMatchInlineSnapshot(`
      {
        "aiModels": [],
        "algorithmFiling": null,
        "brand": "goapply",
        "complaints": null,
        "edi": null,
        "entity": null,
        "genaiRegistration": null,
        "hrLicence": null,
        "icp": null,
        "links": [
          {
            "doc": "terms",
            "href": "/legal/terms",
          },
          {
            "doc": "privacy",
            "href": "/legal/privacy",
          },
          {
            "doc": "pi-collection-list",
            "href": "/legal/pi-collection-list",
          },
          {
            "doc": "third-party-sharing",
            "href": "/legal/third-party-sharing",
          },
          {
            "doc": "ai-content-labels",
            "href": "/legal/ai-content-labels",
          },
          {
            "doc": "complaints",
            "href": "/legal/complaints",
          },
        ],
        "market": "cn",
        "psb": null,
        "statusNote": null,
      }
    `);
  });

  it('the GoApply footer names the model it really runs on: the shared one when it has none of its own, never an unset CN_ name (D5)', () => {
    const shared = { LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openai/gpt-5' };
    expect(buildLegalFooter(goapply, shared).aiModels).toEqual([{ vendor: 'openai', model: 'gpt-5', filingNo: null }]);
    // Its own model replaces it, with its filing number when one is set.
    const own = { ...shared, CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat', CN_GENAI_DISCLOSURES: '[{"model":"deepseek-chat","vendor":"deepseek","filingNo":"F-1"}]' };
    expect(buildLegalFooter(goapply, own).aiModels).toEqual([{ vendor: 'deepseek', model: 'deepseek-chat', filingNo: 'F-1' }]);
    // RoboApply's footer has no model line (a GoApply legal-footer item), whatever is configured.
    expect(buildLegalFooter(roboapply, shared).aiModels).toEqual([]);
  });

  it('with env: every configured line, regulator links', () => {
    const env = {
      CN_LEGAL_ENTITY_NAME: '某某科技有限公司',
      CN_ICP_NUMBER: '沪ICP备00000000号-1',
      CN_PSB_NUMBER: '沪公网安备 00000000000000号',
      CN_PSB_RECORD_CODE: '00000000000000',
      CN_EDI_LICENCE_NUMBER: '沪B2-00000000',
      CN_HR_LICENCE_NUMBER: 'HR-1',
      CN_HR_LICENCE_HOLDER: '某某人力资源有限公司',
      CN_LLM_PROVIDER: 'deepseek',
      CN_LLM_MODEL: 'deepseek-chat',
      CN_GENAI_APP_REGISTRATION_NO: 'REG-1',
      CN_GENAI_STATUS_NOTE: '备案中',
      CN_COMPLAINT_EMAIL: 'jubao@example.cn',
    };
    const f = buildLegalFooter(goapply, env);
    expect(f.entity).toBe('某某科技有限公司');
    expect(f.icp).toEqual({ number: '沪ICP备00000000号-1', url: ICP_LOOKUP_URL });
    expect(f.icp!.url).toBe('https://beian.miit.gov.cn/');
    expect(f.psb).toEqual({ number: '沪公网安备 00000000000000号', url: 'https://beian.mps.gov.cn/#/query/webSearch?code=00000000000000' });
    expect(f.edi).toBe('沪B2-00000000');
    expect(f.hrLicence).toEqual({ number: 'HR-1', holder: '某某人力资源有限公司' });
    expect(f.aiModels).toEqual([{ vendor: 'deepseek', model: 'deepseek-chat', filingNo: null }]);
    expect(f.genaiRegistration).toBe('REG-1');
    expect(f.statusNote).toBe('备案中');
    expect(f.complaints).toEqual({ email: 'jubao@example.cn', phone: null });
  });

  it('RoboApply never shows CN filing lines even when the env exists', () => {
    const f = buildLegalFooter(roboapply, { CN_ICP_NUMBER: 'x', LEGAL_ENTITY_NAME: 'Example Ltd' });
    expect(f.icp).toBeNull();
    expect(f.entity).toBe('Example Ltd');
    expect(f.links.map((l) => l.doc)).toEqual(LEGAL_FOOTER_DOCS.intl);
  });

  it('half-configured HR licence (no holder) is not shown', () => {
    expect(buildLegalFooter(goapply, { CN_HR_LICENCE_NUMBER: 'HR-1' }).hrLicence).toBeNull();
  });
});

describe('legal doc slugs', () => {
  it('resolves per market, with aliases', () => {
    expect(resolveLegalDocSlug('cn', 'terms')).toEqual({ doc: 'terms', file: 'user-agreement' });
    expect(resolveLegalDocSlug('cn', 'agreement')).toEqual({ redirect: 'terms' });
    expect(resolveLegalDocSlug('cn', 'personal-info-list')).toEqual({ redirect: 'pi-collection-list' });
    expect(resolveLegalDocSlug('cn', 'ai-disclosure')).toEqual({ redirect: 'ai-content-labels' });
    expect(resolveLegalDocSlug('intl', 'ai-disclosure')).toEqual({ doc: 'ai-disclosure', file: 'ai-disclosure' });
    expect(resolveLegalDocSlug('intl', 'pi-collection-list')).toBeNull();
    expect(resolveLegalDocSlug('cn', 'cookies')).toBeNull();
    expect(resolveLegalDocSlug('intl', '../etc/passwd')).toBeNull();
  });
});

// ── Data export (WP-93: wave 4 #10; wave 5 #10, #37, #38) ───────────────────

describe('data export: People, 内推码, referrals, two-step sign-in, student domain', () => {
  const at = (d: string) => new Date(`${d}T08:00:00.000Z`);
  const now = at('2026-10-10');

  function seeded() {
    return createFakePrisma({
      seed: {
        user: [{ id: 'u1', email: 'me@example.test', brand: 'goapply' }],
        rAOutreachDraft: [
          { id: 'od1', userId: 'u1', contactId: 'ct9', jobId: 'j1', trackerEntryId: 't1', channel: 'referral_ask', subject: 'Quick question', body: 'Hi Sam, could you refer me?', model: 'internal-model-x', copiedAt: at('2026-10-02'), markedSentAt: null, createdAt: at('2026-10-01') },
          { id: 'od2', userId: 'someone-else', channel: 'email', body: 'not mine', createdAt: at('2026-10-01') },
        ],
        rACnReferralCode: [
          { id: 'rc1', brand: 'goapply', userId: 'u1', company: '示例科技', companyNormalized: 'shili-keji', code: 'NTM2026', programme: '2027 校招', expiresAt: at('2026-12-31'), note: '研发岗', status: 'approved', rejectReason: null, reportCount: 3, hiddenAt: null, moderatedAt: at('2026-10-03'), moderatedById: 'admin-77', createdAt: at('2026-10-02'), updatedAt: at('2026-10-03') },
          { id: 'rc2', brand: 'goapply', userId: 'someone-else', company: '别家', companyNormalized: 'biejia', code: 'OTHER', status: 'approved', createdAt: at('2026-10-02'), updatedAt: at('2026-10-02') },
        ],
        rAReferral: [
          { id: 'rf1', brand: 'goapply', inviterUserId: 'u1', inviteeUserId: 'friend-1', status: 'rewarded', riskScore: 7, riskReasons: ['same_device'], qualifiedAt: at('2026-09-05'), rewardedAt: at('2026-09-06'), createdAt: at('2026-09-01') },
          { id: 'rf2', brand: 'goapply', inviterUserId: 'u1', inviteeUserId: 'friend-2', status: 'pending', riskScore: 0, riskReasons: [], qualifiedAt: null, rewardedAt: null, createdAt: at('2026-09-20') },
          { id: 'rf3', brand: 'goapply', inviterUserId: 'inviter-9', inviteeUserId: 'u1', status: 'qualified', riskScore: 1, riskReasons: [], qualifiedAt: at('2026-08-02'), rewardedAt: null, createdAt: at('2026-08-01') },
          { id: 'rf4', brand: 'goapply', inviterUserId: 'inviter-9', inviteeUserId: 'friend-3', status: 'rewarded', createdAt: at('2026-08-01') },
        ],
        rATwoFactor: [
          { userId: 'u1', brand: 'goapply', secretSealed: 'v1.sealed-totp-secret', enabledAt: at('2026-09-15'), lastUsedStep: 58812345, recoveryCodeHashes: ['recovery-hash-aaa', 'recovery-hash-bbb'], recoveryCodesGeneratedAt: at('2026-09-15'), createdAt: at('2026-09-15') },
        ],
        rAStudentVerification: [
          { userId: 'u1', brand: 'goapply', schoolEmailHash: 'school-email-hash-zzz', schoolDomain: 'pku.edu.cn', pendingEmailHash: 'pending-hash-yyy', pendingDomain: 'tsinghua.edu.cn', codeHash: 'code-hash-xxx', codeAttempts: 2, verifiedAt: at('2026-09-10'), expiresAt: at('2027-09-10'), createdAt: at('2026-09-10') },
        ],
        rAJobInteraction: [
          { id: 'ji1', userId: 'u1', jobId: 'j1', kind: 'view', createdAt: at('2026-10-01') },
          { id: 'ji2', userId: 'u1', jobId: 'j2', kind: 'save', createdAt: at('2026-10-02') },
          { id: 'ji3', userId: 'u1', jobId: 'j3', kind: 'admin_review', meta: { decision: 'removed', note: 'internal moderation note' }, createdAt: at('2026-10-03') },
        ],
      },
    });
  }

  it('registers the sections', () => {
    for (const name of ['outreachDrafts', 'referralCodes', 'referrals', 'twoStepSignIn', 'studentVerification', 'jobInteractions']) {
      expect(exportSectionNames(), name).toContain(name);
    }
  });

  it('outreachDrafts: the text and what the user did with it — only their own rows, no model or internal ids', async () => {
    const out = await buildUserDataExport('u1', seeded() as unknown as ExportDb, now);
    expect(out.outreachDrafts).toEqual([
      { channel: 'referral_ask', subject: 'Quick question', body: 'Hi Sam, could you refer me?', jobId: 'j1', trackerEntryId: 't1', copiedAt: at('2026-10-02'), markedSentAt: null, createdAt: at('2026-10-01') },
    ]);
  });

  it('referralCodes (内推码): the code and its review outcome, without the reviewer or the report count', async () => {
    const out = await buildUserDataExport('u1', seeded() as unknown as ExportDb, now);
    expect(out.referralCodes).toEqual([
      { company: '示例科技', code: 'NTM2026', programme: '2027 校招', expiresAt: at('2026-12-31'), note: '研发岗', status: 'approved', rejectReason: null, createdAt: at('2026-10-02'), updatedAt: at('2026-10-03') },
    ]);
    const text = JSON.stringify(out.referralCodes);
    expect(text).not.toContain('admin-77');
    expect(text).not.toContain('reportCount');
  });

  it('referrals: status and dates only — no friend identity in either direction, no risk signals', async () => {
    const out = await buildUserDataExport('u1', seeded() as unknown as ExportDb, now);
    expect(out.referrals).toEqual({
      invited: [
        { status: 'rewarded', createdAt: at('2026-09-01'), qualifiedAt: at('2026-09-05'), rewardedAt: at('2026-09-06') },
        { status: 'pending', createdAt: at('2026-09-20'), qualifiedAt: null, rewardedAt: null },
      ],
      invitedBy: { status: 'qualified', createdAt: at('2026-08-01'), qualifiedAt: at('2026-08-02'), rewardedAt: null },
    });
    const text = JSON.stringify(out);
    for (const secret of ['friend-1', 'friend-2', 'friend-3', 'inviter-9', 'inviteeUserId', 'inviterUserId', 'riskScore', 'riskReasons', 'same_device']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('twoStepSignIn: on/off and when — never the secret, the recovery codes or the replay counter', async () => {
    const out = await buildUserDataExport('u1', seeded() as unknown as ExportDb, now);
    expect(out.twoStepSignIn).toEqual({ enabled: true, enrolledAt: at('2026-09-15') });
    const text = JSON.stringify(out);
    for (const secret of ['sealed-totp-secret', 'secretSealed', 'recovery-hash-aaa', 'recovery-hash-bbb', 'recoveryCodeHashes', '58812345', 'lastUsedStep']) {
      expect(text, secret).not.toContain(secret);
    }
    // Never enrolled, or enrolment started but not confirmed: off, no date.
    const none = await buildUserDataExport('nobody', seeded() as unknown as ExportDb, now);
    expect(none.twoStepSignIn).toEqual({ enabled: false, enrolledAt: null });
    const pending = createFakePrisma({ seed: { rATwoFactor: [{ userId: 'u2', brand: 'roboapply', secretSealed: 'v1.pending-secret', enabledAt: null, recoveryCodeHashes: [] }] } });
    const half = await buildUserDataExport('u2', pending as unknown as ExportDb, now);
    expect(half.twoStepSignIn).toEqual({ enabled: false, enrolledAt: null });
    expect(JSON.stringify(half)).not.toContain('pending-secret');
  });

  it('studentVerification: the school domain and its dates — no address hash, no pending address, no code', async () => {
    const out = await buildUserDataExport('u1', seeded() as unknown as ExportDb, now);
    expect(out.studentVerification).toEqual({ schoolDomain: 'pku.edu.cn', verifiedAt: at('2026-09-10'), expiresAt: at('2027-09-10') });
    const text = JSON.stringify(out);
    for (const secret of ['school-email-hash-zzz', 'pending-hash-yyy', 'tsinghua.edu.cn', 'code-hash-xxx', 'codeAttempts']) {
      expect(text, secret).not.toContain(secret);
    }
    expect((await buildUserDataExport('nobody', seeded() as unknown as ExportDb, now)).studentVerification).toBeNull();
  });

  it("jobInteractions: the user's own activity; admin_review rows are left out", async () => {
    const out = await buildUserDataExport('u1', seeded() as unknown as ExportDb, now);
    expect((out.jobInteractions as Array<{ kind: string }>).map((r) => r.kind)).toEqual(['view', 'save']);
    const text = JSON.stringify(out);
    expect(text).not.toContain('admin_review');
    expect(text).not.toContain('internal moderation note');
  });

  it('no section failed', async () => {
    const out = await buildUserDataExport('u1', seeded() as unknown as ExportDb, now);
    expect(out.sectionsUnavailable).toBeUndefined();
  });
});
