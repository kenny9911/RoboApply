// @vitest-environment node
//
// WP-65 routes and services: the guided builder (config per brand/locale, AI
// suggestions gated by consent with zero model calls when off, credits,
// CitationGuard, create), layout save (WP-36b keys + personal / photo /
// headingLanguage) and fit to one page (never changes the text).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { CreditsExhaustedError } from '../../platform/credits/index.js';
import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { HttpError } from '../../platform/http.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { countResumePages } from '../../roboapply/v2/lib/resumeExport.js';
import { createResumeSuiteRouter } from './routes.js';
import { BuilderService, type BuilderServiceDeps } from './builder/BuilderService.js';
import { LayoutService } from './layout/LayoutService.js';
import { createMemoryLayoutStore } from './layout/store.js';
import { CN_DRAFT, SENSITIVE } from './builder/fixtures.js';
import type { BuilderConfigView, BuilderCreateResponse, BuilderSuggestResponse, FitToPageResponse } from './contract.js';

const BASE = '/api/v1/roboapply/v2/resumes';
const USER = 'u_wp65';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

let ai = true;
let market: 'intl' | 'cn' = 'intl';
const kit = createCreditTestKit();
const suggest = vi.fn(async (_input: unknown) => ({ suggestions: ['Built 3 weekly sales reports in SQL', 'Cleaned the sales data each week'] }));
const logAiLabel = vi.fn(async () => undefined);
const created: Array<{ name: string; markdown: string }> = [];
const layoutStore = createMemoryLayoutStore();
const layoutService = new LayoutService({ store: layoutStore, countPages: (md, o) => countResumePages(md, o), market: () => market });
const patchMeta = vi.fn(async (_userId: string, _id: string, _meta: { targetTitle?: string; aiAssisted?: boolean }) => undefined);
const deleted: string[] = [];
let layoutFails = false;
let builderAiUsed = false;
const builderAiUsedSince = vi.fn(async (_userId: string, _since: Date) => builderAiUsed);
let full = false;

const deps: BuilderServiceDeps = {
  credits: kit.credits,
  aiAvailable: async () => ai,
  market: () => market,
  suggest: (input) => suggest(input),
  logAiLabel,
  createResume: async (userId, input) => {
    if (full) throw new HttpError('conflict', 'Every resume slot is in use.', { reason: 'resume_limit_reached', limit: 5 });
    const id = `rv_new_${created.length + 1}`;
    created.push(input);
    layoutStore.rows.set(id, { id, userId, resumeMarkdown: input.markdown, layout: null });
    return { id };
  },
  saveLayout: async (userId, id, layout) => {
    if (layoutFails) throw new Error('layout store down');
    await layoutService.patch(userId, id, layout);
  },
  patchMeta,
  deleteResume: async (_userId, id) => {
    deleted.push(id);
    layoutStore.rows.delete(id);
  },
  builderAiUsedSince,
};
const builder = new BuilderService(deps);

let h: RouteHarness;

const LONG = [
  '# Sam Rivera',
  '*Analyst · sam@example.test · Austin, TX*',
  '',
  '## Experience',
  '',
  ...Array.from({ length: 8 }, (_, i) => [
    `### Company ${i + 1} · Analyst · 20${10 + i} – 20${11 + i}`,
    ...Array.from({ length: 5 }, (_, j) => `- Prepared report ${j + 1} for the team and checked every figure with the finance group before it went out.`),
    '',
  ]).flat(),
  '## Skills',
  '',
  'SQL · Excel · Tableau',
].join('\n');

beforeAll(async () => {
  layoutStore.rows.set('rv_long', { id: 'rv_long', userId: USER, resumeMarkdown: LONG, layout: { template: 'standard', accent: '#1f3a68' } });
  layoutStore.rows.set('rv_short', { id: 'rv_short', userId: USER, resumeMarkdown: '# Kim\n\n## Skills\n\nSQL\n', layout: null });
  layoutStore.rows.set('rv_huge', {
    id: 'rv_huge',
    userId: USER,
    resumeMarkdown: ['# Huge', '## Experience', ...Array.from({ length: 220 }, (_, i) => `- Line ${i} of a very long resume that cannot fit on one page whatever the spacing is.`)].join('\n'),
    layout: null,
  });
  h = await startRouteHarness({
    mounts: [
      [
        BASE,
        createResumeSuiteRouter(
          { seekerAuth: [fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: USER }))] },
          {
            builder,
            layout: layoutService,
            phoneGate: (_req, _res, next) => next(),
            loadView: async (_userId, id) => ({ id, layout: layoutStore.rows.get(id)?.layout ?? null }),
          },
        ),
      ],
    ],
  });
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  ai = true;
  market = 'intl';
  full = false;
  layoutFails = false;
  builderAiUsed = false;
  deleted.length = 0;
  suggest.mockClear();
  logAiLabel.mockClear();
  patchMeta.mockClear();
  builderAiUsedSince.mockClear();
});

describe('GET /builder/config', () => {
  it('401 without a session', async () => {
    const res = await h.request('GET', `${BASE}/builder/config`, { headers: { 'x-test-anon': '1' } });
    expect(res.status).toBe(401);
  });

  it('RoboApply (en) → intl steps; zh-TW → tw; GoApply → cn', async () => {
    const intl = await h.request<Env<BuilderConfigView>>('GET', `${BASE}/builder/config`);
    expect(intl.status).toBe(200);
    expect(intl.body.data.variant).toBe('intl');
    const tw = await h.request<Env<BuilderConfigView>>('GET', `${BASE}/builder/config`, { headers: { 'X-Robo-Locale': 'zh-TW' } });
    expect(tw.body.data.variant).toBe('tw');
    market = 'cn';
    const cn = await h.request<Env<BuilderConfigView>>('GET', `${BASE}/builder/config`);
    expect(cn.body.data.variant).toBe('cn');
    expect(cn.body.data.page).toBe('a4');
  });

  it('reports AI off and drops the AI actions', async () => {
    ai = false;
    const res = await h.request<Env<BuilderConfigView>>('GET', `${BASE}/builder/config`);
    expect(res.body.data.aiAvailable).toBe(false);
    expect(res.body.data.steps.every((s) => s.ai === null)).toBe(true);
  });
});

describe('POST /builder/suggest', () => {
  const body = { kind: 'bullets', docLanguage: 'en', targetTitle: 'Data analyst', entry: { title: 'Intern', organization: 'Acme', section: 'experience' }, notes: 'made 3 weekly sales reports in SQL; cleaned data' };

  it('returns AI-written suggestions and spends one rewrite credit', async () => {
    const before = (await kit.credits.usage(USER)).find((b) => b.bucket === 'rewrite')!.used;
    const res = await h.request<Env<BuilderSuggestResponse>>('POST', `${BASE}/builder/suggest`, { body, headers: { 'Idempotency-Key': 's1' } });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([
      { text: 'Built 3 weekly sales reports in SQL', aiWritten: true },
      { text: 'Cleaned the sales data each week', aiWritten: true },
    ]);
    const after = (await kit.credits.usage(USER)).find((b) => b.bucket === 'rewrite')!.used;
    expect(after).toBe(before + 1);
    expect(logAiLabel).not.toHaveBeenCalled();
  });

  it('with AI consent off: 503 ai_unavailable and zero model calls', async () => {
    ai = false;
    const res = await h.request<Env<unknown>>('POST', `${BASE}/builder/suggest`, { body });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_unavailable');
    expect(suggest).not.toHaveBeenCalled();
  });

  it('CitationGuard drops suggestions with numbers the user did not write', async () => {
    suggest.mockResolvedValueOnce({ suggestions: ['Cut reporting time by 40%', 'Built 3 weekly sales reports in SQL'] });
    const res = await h.request<Env<BuilderSuggestResponse>>('POST', `${BASE}/builder/suggest`, { body, headers: { 'Idempotency-Key': 's2' } });
    expect(res.body.data.suggestions.map((s) => s.text)).toEqual(['Built 3 weekly sales reports in SQL']);
    expect(res.body.data.blocked).toBe(1);
  });

  it('409 citation_guard (no credit used) when every suggestion invents a number', async () => {
    const before = (await kit.credits.usage(USER)).find((b) => b.bucket === 'rewrite')!.used;
    suggest.mockResolvedValueOnce({ suggestions: ['Saved $2M'] });
    const res = await h.request<Env<unknown>>('POST', `${BASE}/builder/suggest`, { body, headers: { 'Idempotency-Key': 's3' } });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'citation_guard' });
    expect((await kit.credits.usage(USER)).find((b) => b.bucket === 'rewrite')!.used).toBe(before);
  });

  it('503 (no credit used) when the model fails', async () => {
    suggest.mockRejectedValueOnce(new Error('provider down'));
    const res = await h.request<Env<unknown>>('POST', `${BASE}/builder/suggest`, { body, headers: { 'Idempotency-Key': 's4' } });
    expect(res.status).toBe(503);
  });

  it('402 credits_exhausted', async () => {
    vi.spyOn(kit.credits, 'withCredit').mockRejectedValueOnce(
      new CreditsExhaustedError({ bucket: 'rewrite', resetsAt: new Date('2026-10-11T00:00:00Z'), upgradable: true, cap: 20, window: 'day' }),
    );
    const res = await h.request<Env<unknown>>('POST', `${BASE}/builder/suggest`, { body, headers: { 'Idempotency-Key': 's5' } });
    expect(res.status).toBe(402);
  });

  it('GoApply logs the AI-content label', async () => {
    market = 'cn';
    const res = await h.request<Env<BuilderSuggestResponse>>('POST', `${BASE}/builder/suggest`, { body: { ...body, docLanguage: 'zh' }, headers: { 'Idempotency-Key': 's6' } });
    expect(res.status).toBe(200);
    expect(logAiLabel).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, kind: 'resume_builder' }));
  });

  it('never passes personal details to the model, and refuses a personal field', async () => {
    await h.request('POST', `${BASE}/builder/suggest`, {
      body: { ...body, docLanguage: 'zh', notes: `整理销售数据\n籍贯：${SENSITIVE.nativePlace}\n政治面貌：${SENSITIVE.politicalStatus}\n性别：女\n出生年月：2003.05` },
      headers: { 'Idempotency-Key': 's7' },
    });
    const sent = JSON.stringify(suggest.mock.calls.at(-1)![0]);
    expect(sent).toContain('整理销售数据');
    for (const v of [SENSITIVE.nativePlace, SENSITIVE.politicalStatus, '性别', '出生']) expect(sent).not.toContain(v);
    const refused = await h.request<Env<unknown>>('POST', `${BASE}/builder/suggest`, { body: { ...body, personal: { nativePlace: 'x' } } });
    expect(refused.status).toBe(422);
  });

  it('422 without notes or context', async () => {
    const res = await h.request<Env<unknown>>('POST', `${BASE}/builder/suggest`, { body: { kind: 'summary', docLanguage: 'en' } });
    expect(res.status).toBe(422);
    expect(suggest).not.toHaveBeenCalled();
  });
});

describe('POST /builder', () => {
  it('creates the resume, saves the layout with the personal details, sets the target title', async () => {
    market = 'cn';
    patchMeta.mockClear();
    const res = await h.request<Env<BuilderCreateResponse>>('POST', `${BASE}/builder`, { body: { ...CN_DRAFT, aiAssisted: true } });
    expect(res.status).toBe(200);
    const id = res.body.data.resumeId;
    const row = layoutStore.rows.get(id)!;
    expect(row.resumeMarkdown).toContain('## 实习经历');
    for (const v of Object.values(SENSITIVE)) expect(row.resumeMarkdown).not.toContain(v);
    expect(row.layout).toEqual({ template: 'campus', page: 'a4', personal: { nativePlace: SENSITIVE.nativePlace, politicalStatus: SENSITIVE.politicalStatus }, photo: true });
    expect(patchMeta).toHaveBeenCalledWith(USER, id, { targetTitle: '数据分析实习生', aiAssisted: true });
  });

  it('GoApply: marks the resume AI-assisted when builder suggestions were issued, even if the client says no', async () => {
    market = 'cn';
    builderAiUsed = true;
    const res = await h.request<Env<BuilderCreateResponse>>('POST', `${BASE}/builder`, { body: { ...CN_DRAFT, aiAssisted: false } });
    expect(res.status).toBe(200);
    expect(builderAiUsedSince).toHaveBeenCalledTimes(1);
    const since = builderAiUsedSince.mock.calls[0]![1];
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(patchMeta).toHaveBeenCalledWith(USER, res.body.data.resumeId, expect.objectContaining({ aiAssisted: true }));
  });

  it('GoApply without issued suggestions and RoboApply: no server-side AI mark', async () => {
    market = 'cn';
    const cn = await h.request<Env<BuilderCreateResponse>>('POST', `${BASE}/builder`, { body: { ...CN_DRAFT, aiAssisted: false } });
    expect(patchMeta).toHaveBeenCalledWith(USER, cn.body.data.resumeId, { targetTitle: '数据分析实习生' });
    market = 'intl';
    builderAiUsed = true;
    builderAiUsedSince.mockClear();
    await h.request('POST', `${BASE}/builder`, { body: { docLanguage: 'en', basics: { fullName: 'Kim' } } });
    expect(builderAiUsedSince).not.toHaveBeenCalled();
  });

  it('all or nothing: a failed layout save removes the new resume, so a retry makes no duplicate', async () => {
    const before = created.length;
    layoutFails = true;
    const failed = await h.request<Env<unknown>>('POST', `${BASE}/builder`, { body: { docLanguage: 'en', basics: { fullName: 'Kim' } } });
    expect(failed.status).toBe(500);
    expect(created.length).toBe(before + 1);
    const orphan = `rv_new_${created.length}`;
    expect(deleted).toEqual([orphan]);
    expect(layoutStore.rows.has(orphan)).toBe(false);
    expect(patchMeta).not.toHaveBeenCalled();
    layoutFails = false;
    const retry = await h.request<Env<BuilderCreateResponse>>('POST', `${BASE}/builder`, { body: { docLanguage: 'en', basics: { fullName: 'Kim' } } });
    expect(retry.status).toBe(200);
    expect(deleted).toEqual([orphan]);
  });

  it('409 resume_limit_reached when every slot is taken', async () => {
    full = true;
    const res = await h.request<Env<unknown>>('POST', `${BASE}/builder`, { body: { docLanguage: 'en', basics: { fullName: 'Kim' } } });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'resume_limit_reached' });
  });

  it('422 without a name', async () => {
    const res = await h.request<Env<unknown>>('POST', `${BASE}/builder`, { body: { docLanguage: 'en', basics: { fullName: '' } } });
    expect(res.status).toBe(422);
  });
});

describe('PATCH /:id/layout (WP-36b keys + personal / photo / headingLanguage)', () => {
  it('merges and clears personal details', async () => {
    const id = 'rv_short';
    const a = await h.request<Env<{ resume: { layout: Record<string, unknown> } }>>('PATCH', `${BASE}/${id}/layout`, {
      body: { layout: { template: 'campus', personal: { nativePlace: '江苏南京' }, photo: true, headingLanguage: 'en', bullet: 'dash' } },
    });
    expect(a.status).toBe(200);
    expect(a.body.data.resume.layout).toEqual({ template: 'campus', personal: { nativePlace: '江苏南京' }, photo: true, headingLanguage: 'en', bullet: 'dash' });
    await h.request('PATCH', `${BASE}/${id}/layout`, { body: { layout: { personal: { politicalStatus: '群众' } } } });
    expect(layoutStore.rows.get(id)!.layout).toMatchObject({ personal: { nativePlace: '江苏南京', politicalStatus: '群众' } });
    await h.request('PATCH', `${BASE}/${id}/layout`, { body: { layout: { personal: null } } });
    expect(layoutStore.rows.get(id)!.layout).not.toHaveProperty('personal');
  });

  it('422 on unknown keys, 404 on someone else\'s resume', async () => {
    const bad = await h.request<Env<unknown>>('PATCH', `${BASE}/rv_short/layout`, { body: { layout: { colour: 'red' } } });
    expect(bad.status).toBe(422);
    const missing = await h.request<Env<unknown>>('PATCH', `${BASE}/nope/layout`, { body: { layout: { template: 'standard' } } });
    expect(missing.status).toBe(404);
  });
});

describe('POST /:id/fit-to-page', () => {
  it('fits a two-page resume on one page by changing spacing / margins / sizes only', async () => {
    const before = JSON.parse(JSON.stringify(layoutStore.rows.get('rv_long')!));
    const res = await h.request<Env<FitToPageResponse>>('POST', `${BASE}/rv_long/fit-to-page`, { body: {} });
    expect(res.status).toBe(200);
    const fit = res.body.data;
    expect(fit.pages.before).toBeGreaterThan(1);
    expect(fit.status).toBe('fitted');
    expect(fit.pages.after).toBe(1);
    const row = layoutStore.rows.get('rv_long')!;
    // Never deletes content: the text is byte-for-byte the same.
    expect(row.resumeMarkdown).toBe(before.resumeMarkdown);
    // Only sizes and spacing changed; the other layout keys are kept.
    const { sizes, spacing, ...rest } = row.layout as Record<string, unknown>;
    expect(rest).toEqual(before.layout);
    expect(sizes).toEqual(fit.applied!.sizes);
    expect(spacing).toEqual(fit.applied!.spacing);
    expect(await countResumePages(row.resumeMarkdown, { layout: row.layout })).toBe(1);
    // Undo = PATCH the stored values back: the layout is exactly what it was
    // (no template defaults pinned as explicit sizes / spacing).
    expect(fit.restore.sizes).toEqual({ name: null, section: null, sub: null, body: null });
    const undo = await h.request('PATCH', `${BASE}/rv_long/layout`, { body: { layout: fit.restore } });
    expect(undo.status).toBe(200);
    expect(layoutStore.rows.get('rv_long')!.layout).toEqual(before.layout);
    expect(await countResumePages(row.resumeMarkdown, { layout: layoutStore.rows.get('rv_long')!.layout })).toBe(fit.pages.before);
  }, 60_000);

  it('undo restores partly stored sizes exactly, so a later template switch uses that template\'s defaults', async () => {
    const stored = { template: 'campus', sizes: { name: 20 }, spacing: { marginX: 50 } };
    layoutStore.rows.set('rv_partial', { id: 'rv_partial', userId: USER, resumeMarkdown: LONG, layout: JSON.parse(JSON.stringify(stored)) });
    const res = await h.request<Env<FitToPageResponse>>('POST', `${BASE}/rv_partial/fit-to-page`, { body: {} });
    const fit = res.body.data;
    expect(fit.status).toBe('fitted');
    expect(fit.restore).toEqual({
      sizes: { name: 20, section: null, sub: null, body: null },
      spacing: { section: null, entry: null, line: null, marginX: 50, marginY: null },
    });
    await h.request('PATCH', `${BASE}/rv_partial/layout`, { body: { layout: fit.restore } });
    expect(layoutStore.rows.get('rv_partial')!.layout).toEqual(stored);
    // sizes: null / spacing: null clear every stored value.
    await h.request('PATCH', `${BASE}/rv_partial/layout`, { body: { layout: { sizes: null, spacing: null } } });
    expect(layoutStore.rows.get('rv_partial')!.layout).toEqual({ template: 'campus' });
  }, 60_000);

  it('reserves the device photo box while counting pages when the client says a photo is placed', async () => {
    const seen: Array<Buffer | null | undefined> = [];
    const spyService = new LayoutService({
      store: layoutStore,
      countPages: async (md, o) => {
        seen.push(o.photo);
        return countResumePages(md, o);
      },
      market: () => 'intl',
    });
    await spyService.fit(USER, 'rv_short', { pages: 1, defaultPage: 'letter', photo: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => Buffer.isBuffer(p) && p.length > 0)).toBe(true);
    seen.length = 0;
    await spyService.fit(USER, 'rv_short', { pages: 1, defaultPage: 'letter' });
    expect(seen.every((p) => p === null)).toBe(true);
    const viaRoute = await h.request<Env<FitToPageResponse>>('POST', `${BASE}/rv_short/fit-to-page`, { body: { pages: 1, photo: true } });
    expect(viaRoute.status).toBe(200);
  });

  it('already fits: nothing changes', async () => {
    const res = await h.request<Env<FitToPageResponse>>('POST', `${BASE}/rv_short/fit-to-page`, { body: { pages: 1 } });
    expect(res.body.data.status).toBe('already_fits');
    expect(res.body.data.applied).toBeNull();
  });

  it('too long: says so and changes nothing', async () => {
    const res = await h.request<Env<FitToPageResponse>>('POST', `${BASE}/rv_huge/fit-to-page`, { body: {} });
    expect(res.body.data.status).toBe('too_long');
    expect(layoutStore.rows.get('rv_huge')!.layout).toBeNull();
  }, 60_000);

  it('2 pages only on GoApply; 422 on other values; 404 when not found', async () => {
    const intl = await h.request<Env<FitToPageResponse>>('POST', `${BASE}/rv_short/fit-to-page`, { body: { pages: 2 } });
    expect(intl.body.data.pages.target).toBe(1);
    market = 'cn';
    const cn = await h.request<Env<FitToPageResponse>>('POST', `${BASE}/rv_short/fit-to-page`, { body: { pages: 2 } });
    expect(cn.body.data.pages.target).toBe(2);
    const bad = await h.request<Env<unknown>>('POST', `${BASE}/rv_short/fit-to-page`, { body: { pages: 3 } });
    expect(bad.status).toBe(422);
    const missing = await h.request<Env<unknown>>('POST', `${BASE}/nope/fit-to-page`, { body: {} });
    expect(missing.status).toBe(404);
  });
});
