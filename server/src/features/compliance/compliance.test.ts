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
import { ICP_LOOKUP_URL, LEGAL_FOOTER_DOCS, resolveLegalDocSlug } from './contract.js';
import { buildDisclosures, buildLegalFooter, configuredModels, parseGenaiDisclosures, parseModelId } from './disclosures.js';
import { EXPLAIN_KEYS, explainMatch, type ExplainDimension } from './explainMatch.js';
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
