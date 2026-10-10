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
import { GOAPPLY_DIRECT_PROVIDERS, MAINLAND_LLM_HOST_SUFFIXES, hostOf, isMainlandLlmHost } from '../../platform/llm/brandPolicy.js';
import { OPENROUTER_MAINLAND_UPSTREAMS, PROVIDER_DEFAULT_BASE_URLS, checkLlmEgress } from '../../platform/llm/egressPolicy.js';
import { residencySummary } from '../../platform/residency/summary.js';
import { jobDataAttributions } from '../jobs/data/index.js';
import {
  buildDisclosures,
  buildLegalFooter,
  configuredModels,
  dataAttributions,
  llmEndpointFacts,
  parseGenaiDisclosures,
  parseModelId,
  processingFacts,
} from './disclosures.js';
import { EXPLAIN_KEYS, explainMatch, type ExplainDimension } from './explainMatch.js';
import { processingFactsMarkdown } from './legalDocs.js';
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
    expect(e.gaps.map((g) => g.key)).toEqual(['legal.explain.gap.industry', 'legal.explain.notStated.logistics', 'legal.explain.gap.skillsMissing']);
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

  it('emits only known keys (all present in the legal bundle)', async () => {
    const { default: bundle } = await import('../../../../i18n/staging/legal.en.json', { with: { type: 'json' } });
    const get = (path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundle);
    for (const key of EXPLAIN_KEYS) expect(typeof get(key), key).toBe('string');
    const e = explainMatch({ market: 'cn', personalized: true, score: 50, kind: 'ai', dimensions: dims, skills: { aligned: ['a'], missing: ['b'] } });
    for (const l of [e.headline, ...e.reasons, ...e.gaps, ...e.notices]) expect(EXPLAIN_KEYS).toContain(l.key);
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

  it('GoApply models come only from CN_ env (no fallback to the intl stack)', () => {
    const env = { LLM_MODEL: 'openrouter/x/y', CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat', CN_GENAI_DISCLOSURES: '[{"model":"deepseek-chat","vendor":"deepseek","filingNo":"F-1"}]' };
    expect(configuredModels(goapply, env)).toEqual([{ task: 'default', vendor: 'deepseek', model: 'deepseek-chat', region: 'CN', filingNo: 'F-1' }]);
    expect(configuredModels(roboapply, env)).toEqual([{ task: 'default', vendor: 'openrouter', model: 'x/y', region: 'US', filingNo: null }]);
    expect(configuredModels(goapply, {})).toEqual([]);
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
    expect(buildDisclosures(goapply, { DEPLOY_REGION: 'cn-mainland' }).offshore).toBe(false);
    expect(buildDisclosures(roboapply, {}).offshore).toBe(false);
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
    ];
    for (const [brand, env] of cases) {
      const r = residencySummary(brand, env);
      expect(processingFacts(brand, env), `${brand.id} ${JSON.stringify(env)}`).toEqual({
        region: r.region,
        stage: r.stage,
        originalFiles: r.originalFiles,
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
    // CN-0 (GoApply offshore): the notice cannot claim more than the deployment does.
    expect(processingFacts(goapply, {})).toMatchObject({ region: 'offshore', stage: 'cn0', originalFiles: 'not_kept', imagesDiscarded: true });
    expect(processingFacts(goapply, {}).redactedBeforeStorage.length).toBeGreaterThan(0);
    expect(processingFacts(roboapply, {})).toMatchObject({ region: 'offshore', stage: 'intl', redactedBeforeStorage: [], imagesDiscarded: false });
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

  it('GoApply AI endpoints: only domestic providers on allowlisted hosts — every listed route passes the egress policy', () => {
    const f = llmEndpointFacts(goapply, {});
    expect(f.rule).toBe('mainland_only');
    expect(f.excludedUpstreams).toEqual([]);
    expect(f.mainlandHosts).toEqual([...MAINLAND_LLM_HOST_SUFFIXES]);
    expect(f.providers.length).toBeGreaterThanOrEqual(5);
    for (const p of f.providers) {
      expect(GOAPPLY_DIRECT_PROVIDERS as readonly string[], p.provider).toContain(p.provider);
      expect(p.host).toBe(hostOf(PROVIDER_DEFAULT_BASE_URLS[p.provider]));
      expect(isMainlandLlmHost(p.host)).toBe(true);
      expect(checkLlmEgress({ brand: goapply, provider: p.provider, env: {} }).allowed, p.provider).toBe(true);
    }
    // No offshore provider is ever offered to GoApply.
    for (const offshore of ['openai', 'openrouter', 'anthropic', 'google']) expect(f.providers.map((p) => p.provider)).not.toContain(offshore);
    // An ops-added domestic gateway host joins the allowlist.
    expect(llmEndpointFacts(goapply, { CN_LLM_DOMESTIC_HOSTS: 'llm.internal.example.cn' }).mainlandHosts).toContain('llm.internal.example.cn');
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
