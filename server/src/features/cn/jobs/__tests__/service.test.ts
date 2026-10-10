// @vitest-environment node
// WP-41: anti-fraud classifier around the pipeline hooks, the LLM check
// worker, and the admin review / blacklist. Fakes only (no DB, no network).

import { describe, expect, it } from 'vitest';
import {
  addToBlacklist,
  cnAfterEnrich,
  cnAfterNormalize,
  cnImportWarnings,
  fraudCheckDedupeKey,
  fraudSourceKey,
  listBlacklist,
  listFraudQueue,
  removeFromBlacklist,
  resolveFraud,
  runFraudCheck,
} from '../service.js';
import { flagKey } from '../fraud/flags.js';
import { FRAUD_DOMESTIC_PROVIDERS, resolveFraudModel } from '../fraud/llm.js';
import { CN_MODEL_ENV, NOW, cnJob, fakeDeps, fakeLlm, fakeRepo } from './testkit.js';

/** A deployment with only the shared model stack: no CN_ value anywhere (the D5 default). */
const SHARED_MODEL_ENV = { LLM_MODEL: 'openrouter/openai/gpt-5.6-luna', OPENROUTER_API_KEY: 'k' };
import type { MarketHookContext } from '../../../jobs/marketHooks.js';

const ingest: MarketHookContext = { brand: 'goapply', market: 'cn', stage: 'ingest' };
const importCtx: MarketHookContext = { brand: 'goapply', market: 'cn', stage: 'import', userId: 'u1' };
const enrich: MarketHookContext = { brand: 'goapply', market: 'cn', stage: 'enrich' };

const FEE = '入职需缴纳押金500元，三个月后退还。';

/** One stored job (job_1) with a keyword flag on FEE. */
function seeded1() {
  const deps = fakeDeps();
  deps.repo.jobs.set('job_1', cnJob({ descriptionPlain: FEE, fraudFlags: [{ rule: 'upfront_fee', evidence: FEE, at: '2026-10-02T00:00:00.000Z', method: 'keywords' }] }));
  return deps;
}

// MARKET_STRATEGY §1.5, JC-7: recruiter phone numbers and WeChat ids are removed from an indexed
// mainland posting before it is stored, and the mainland fraud rules run on every market cn row.
describe('afterNormalize: mainland text rules on every source', () => {
  /** A posting read from a public employer board, as the normalizer hands it to the hook. */
  const boardJob = (text: string, over: Record<string, unknown> = {}) => ({
    market: 'cn' as const,
    provider: 'ats_public',
    sourceBoard: 'smartrecruiters',
    sourceName: '示例汽车 · SmartRecruiters',
    title: '后端工程师',
    companyName: '示例汽车（中国）投资有限公司',
    description: text,
    descriptionPlain: text,
    notes: [] as string[],
    ...over,
  });

  it('a phone number and a WeChat id in a board posting are removed before it is stored; the rest of the text is untouched', async () => {
    const text = '岗位职责：负责后端服务开发。\n薪资 13000-18000元/月，13薪。\n有意者请联系王经理，电话：13800138000（微信同号），或加微信 hr_wang2026 沟通。';
    const out = await cnAfterNormalize(boardJob(text), ingest, fakeDeps());
    for (const column of [out.description, out.descriptionPlain] as string[]) {
      expect(column).not.toMatch(/13800138000|hr_wang2026|微信同号/);
      expect(column).toContain('岗位职责：负责后端服务开发。');
      expect(column).toContain('薪资 13000-18000元/月，13薪。');
      expect(column).toContain('有意者请联系王经理');
    }
    expect(out.notes).toEqual(['contact_info_removed']);
    // The source name of a board row is the adapter's, not GoHire.
    expect(out.sourceName).toBe('示例汽车 · SmartRecruiters');
  });

  it('markup is kept as it is: only the detail leaves an HTML description', async () => {
    const html = '<p>职责：负责后端开发。</p><p>联系电话：010-12345678 转 801</p>';
    const out = await cnAfterNormalize(boardJob(html, { descriptionPlain: '职责：负责后端开发。\n联系电话：010-12345678 转 801' }), ingest, fakeDeps());
    expect(out.description).toBe('<p>职责：负责后端开发。</p><p></p>');
    expect(out.descriptionPlain).toBe('职责：负责后端开发。');
  });

  it('a board posting in HTML with the label in one tag and the id outside it: neither stored column shows the id', async () => {
    const html = '<p>职责：负责后端开发。</p><p><strong>微信：</strong>hr_zhang01</p><ul><li>加微信&nbsp;<b>hr_li2026</b></li><li>Tel:&nbsp;400-820-8820</li></ul>';
    const out = await cnAfterNormalize(boardJob(html, { descriptionPlain: '职责：负责后端开发。\n微信： hr_zhang01\n• 加微信 hr_li2026\n• Tel: 400-820-8820' }), ingest, fakeDeps());
    for (const column of [out.description, out.descriptionPlain] as string[]) {
      expect(column).not.toMatch(/hr_zhang01|hr_li2026|400-820-8820/);
      expect(column).toContain('职责：负责后端开发。');
    }
    // The markup is still markup.
    expect(out.description).toBe('<p>职责：负责后端开发。</p><p><strong></strong></p><ul><li><b></b></li><li></li></ul>');
    expect(out.notes).toEqual(['contact_info_removed']);
  });

  it('an English board posting that names WeChat as a channel, and one with a reference number, are stored as written', async () => {
    const text = 'Own our social channels (WeChat: official accounts, mini programs; Douyin).\nRequisition ID: 0755-1234-5678\n岗位编号：010-2026-0001';
    const html = `<p>${text.split('\n').join('</p><p>')}</p>`;
    const out = await cnAfterNormalize(boardJob(html, { descriptionPlain: text }), ingest, fakeDeps());
    expect(out.description).toBe(html);
    expect(out.descriptionPlain).toBe(text);
    expect(out.notes).toEqual([]);
  });

  it('a posting with no contact detail is stored byte for byte, with no note', async () => {
    const text = '负责后端服务开发，熟悉微信小程序开发与微信 SDK。\n月薪 15000-25000 元，2027 届毕业生可投。';
    const job = boardJob(text);
    const out = await cnAfterNormalize(job, ingest, fakeDeps());
    expect(out.description).toBe(text);
    expect(out.descriptionPlain).toBe(text);
    expect(out.notes).toEqual([]);
  });

  it('the same rule for a GoHire bank row; a user’s own import keeps its text as pasted (their private copy)', async () => {
    const text = '销售代表。联系手机 139-1234-5678。';
    const bank = await cnAfterNormalize({ market: 'cn', provider: 'bank_gohire', title: '销售代表', companyName: 'A公司', descriptionPlain: text }, ingest, fakeDeps());
    expect(bank.descriptionPlain).toBe('销售代表。');
    const own = await cnAfterNormalize({ market: 'cn', provider: 'user_import', visibility: 'private', title: '销售代表', companyName: 'A公司', descriptionPlain: text }, importCtx, fakeDeps());
    expect(own.descriptionPlain).toBe(text);
    // Another market is not this hook's concern.
    const intl = { market: 'intl' as const, provider: 'ats_public', title: 'Sales', descriptionPlain: 'Call +86 139-1234-5678.' };
    expect(await cnAfterNormalize(intl, { brand: 'roboapply', market: 'intl', stage: 'ingest' }, fakeDeps())).toBe(intl);
  });

  it('the mainland fraud rules and the posting tags run on a board row too, on the text that is stored', async () => {
    const text = `面向2027届毕业生。${FEE}咨询电话：13800138000。`;
    const out = await cnAfterNormalize(boardJob(text), ingest, fakeDeps());
    expect(out.fraudFlags).toEqual([expect.objectContaining({ rule: 'upfront_fee', method: 'keywords', evidence: FEE })]);
    expect(out.marketTags).toEqual([{ tag: 'class_year:2027', evidenceQuote: '面向2027届毕业生。', evidenceUrl: null }]);
    // Every stored quote exists in the stored text.
    for (const flag of out.fraudFlags as Array<{ evidence: string }>) expect(out.descriptionPlain as string).toContain(flag.evidence);
    expect(out.descriptionPlain).not.toContain('13800138000');
  });

  it('quotes carry the posting’s own punctuation: they are cut from the text as written, not from its width-folded copy', async () => {
    const written = '本岗位面向2027届毕业生（校招）。\n网申截止时间：2026年11月30日。';
    const folded = written.normalize('NFKC');
    expect(folded).not.toBe(written);
    const out = await cnAfterNormalize(boardJob(written, { descriptionPlain: folded }), ingest, fakeDeps());
    const quotes = (out.marketTags as Array<{ tag: string; evidenceQuote: string }>).map((t) => [t.tag, t.evidenceQuote]);
    expect(quotes).toContainEqual(['apply_closes:2026-11-30', '网申截止时间：2026年11月30日。']);
    expect(quotes).toContainEqual(['class_year:2027', '本岗位面向2027届毕业生（校招）。']);
    for (const [, quote] of quotes) expect(written).toContain(quote);
    // A row with no as-written text falls back to the plain copy.
    const plainOnly = await cnAfterNormalize({ market: 'cn', provider: 'ats_public', title: 't', companyName: 'c', descriptionPlain: folded }, ingest, fakeDeps());
    expect((plainOnly.marketTags as Array<{ tag: string }>).map((t) => t.tag)).toEqual(expect.arrayContaining(['apply_closes:2026-11-30', 'class_year:2027']));
  });
});

describe('afterNormalize', () => {
  it('names GoHire, flags keyword fraud and reads 届别', async () => {
    const deps = fakeDeps();
    const out = await cnAfterNormalize(
      { market: 'cn', provider: 'bank_gohire', sourceName: null, title: '储备干部', companyName: 'A公司', descriptionPlain: `面向2027届毕业生。${FEE}` },
      ingest,
      deps,
    );
    expect(out.sourceName).toBe('GoHire');
    expect(out.fraudFlags).toEqual([expect.objectContaining({ rule: 'upfront_fee', method: 'keywords', at: NOW.toISOString() })]);
    expect(out.marketTags).toEqual([{ tag: 'class_year:2027', evidenceQuote: '面向2027届毕业生。', evidenceUrl: null }]);
    expect(out.cnFraudWarnings).toBeUndefined();
  });

  it('reads 校招, 网申截止, 实习天数 and 院校层次 next to 届别 — each with its sentence, only when the posting states it', async () => {
    const text = '面向2027届校园招聘。\n每周至少实习4天。\n985/211院校本科及以上优先。\n网申截止时间：2026年11月30日。';
    const out = await cnAfterNormalize({ market: 'cn', provider: 'bank_gohire', title: '后端开发实习生', companyName: 'A公司', descriptionPlain: text }, ingest, fakeDeps());
    const tags = out.marketTags as Array<{ tag: string; evidenceQuote: string }>;
    expect(tags.map((t) => t.tag).sort()).toEqual(['apply_closes:2026-11-30', 'class_year:2027', 'cn_hire:campus', 'intern_days:4', 'school_tier:211', 'school_tier:985']);
    expect(tags.every((t) => text.includes(t.evidenceQuote))).toBe(true);
    // A posting that states none of it gets no tags (the column stays NULL).
    const plain = await cnAfterNormalize({ market: 'cn', provider: 'bank_gohire', title: '后端工程师', companyName: 'A公司', descriptionPlain: '负责后端服务开发。' }, ingest, fakeDeps());
    expect(plain.marketTags).toBeNull();
  });

  it('user import gets warnings (WP-35 shows them before saving)', async () => {
    const out = await cnAfterNormalize({ market: 'cn', provider: 'user_import', title: '客服', companyName: 'B', descriptionPlain: FEE }, importCtx, fakeDeps());
    expect(out.cnFraudWarnings).toEqual([{ rule: 'upfront_fee', evidence: FEE }]);
    expect(cnImportWarnings(out)).toEqual(out.cnFraudWarnings);
  });

  it('blacklisted employer is flagged; a blacklist read failure does not drop the job', async () => {
    const deps = fakeDeps();
    await deps.store.addBlacklist({ employerName: '黑心培训有限公司', reason: '招转培投诉', createdBy: 'admin' });
    const out = await cnAfterNormalize({ market: 'cn', title: '销售', companyName: '黑心培训有限公司（上海）', descriptionPlain: '负责销售。' }, ingest, deps);
    expect(out.fraudFlags).toEqual([expect.objectContaining({ rule: 'blacklisted_employer', method: 'blacklist' })]);

    deps.store.blacklistCached = async () => {
      throw new Error('db down');
    };
    const ok = await cnAfterNormalize({ market: 'cn', title: '销售', companyName: 'X', descriptionPlain: '负责销售。' }, ingest, deps);
    expect(ok.fraudFlags).toBeNull();
  });

  it('an admin clear holds on re-ingest: matched by sourceBoard:externalId before the row id is known', async () => {
    const deps = seeded1();
    await resolveFraud(deps, 'job_1', { decision: 'clear' }, 'admin_1');
    expect(deps.store.reviews[0]!.sourceKey).toBe(fraudSourceKey('gohire', 'gh_job_1'));
    const again = await cnAfterNormalize({ market: 'cn', provider: 'bank_gohire', sourceBoard: 'gohire', externalId: 'gh_job_1', title: '储备干部', companyName: 'A公司', descriptionPlain: FEE }, ingest, deps);
    expect(again.fraudFlags).toBeNull();
    // Another posting with the same sentence is still flagged.
    const other = await cnAfterNormalize({ market: 'cn', provider: 'bank_gohire', sourceBoard: 'gohire', externalId: 'gh_other', title: '储备干部', companyName: 'A公司', descriptionPlain: FEE }, ingest, deps);
    expect(other.fraudFlags).toEqual([expect.objectContaining({ rule: 'upfront_fee' })]);
    // And by row id when the normalized job carries it.
    const byId = await cnAfterNormalize({ id: 'job_1', market: 'cn', title: '储备干部', companyName: 'A公司', descriptionPlain: FEE }, ingest, deps);
    expect(byId.fraudFlags).toBeNull();
  });

  it('a review-log read failure at ingest does not drop the job and writes no new flag: a flag an admin cleared is never raised again by an outage', async () => {
    // job_1's fee sentence was cleared by an admin; the review log then becomes unreadable.
    const deps = seeded1();
    await resolveFraud(deps, 'job_1', { decision: 'clear' }, 'admin_1');
    deps.store.reviewsCached = async () => {
      throw new Error('db down');
    };
    const reingest = { market: 'cn' as const, provider: 'bank_gohire', sourceBoard: 'gohire', externalId: 'gh_job_1', title: '储备干部', companyName: 'A公司', descriptionPlain: FEE };
    const out = await cnAfterNormalize(reingest, ingest, deps);
    // Ingest stores flags add-only, so nothing may be emitted while "cleared" is unknown.
    expect(out.fraudFlags).toBeNull();
    expect(out.title).toBe('储备干部');
    expect(out.sourceName).toBe('GoHire');
    // Flags the job arrived with pass through untouched (not replaced, not dropped).
    const carried = [{ rule: 'training_loan', evidence: '培训贷', at: '2026-10-01T00:00:00.000Z', method: 'llm' }];
    expect((await cnAfterNormalize({ ...reingest, fraudFlags: carried }, ingest, deps)).fraudFlags).toEqual(carried);
    // The tags do not depend on the review log.
    expect((await cnAfterNormalize({ ...reingest, descriptionPlain: `面向2027届毕业生。${FEE}` }, ingest, deps)).marketTags).toEqual([
      { tag: 'class_year:2027', evidenceQuote: '面向2027届毕业生。', evidenceUrl: null },
    ]);
  });

  it('with the review log unreadable, afterEnrich (which retries) is what flags the posting; an import still warns the user before saving', async () => {
    const deps = fakeDeps();
    deps.store.reviewsCached = async () => {
      throw new Error('db down');
    };
    // Import: the user sees the warning before saving, and the import is enriched next.
    const imported = await cnAfterNormalize({ market: 'cn', provider: 'user_import', title: '客服', companyName: 'B', descriptionPlain: FEE }, importCtx, deps);
    expect(imported.cnFraudWarnings).toEqual([{ rule: 'upfront_fee', evidence: FEE }]);
    // Ingest: nothing now; the enrichment hook reads the log itself and flags the stored row.
    const ingested = await cnAfterNormalize({ market: 'cn', title: '客服', companyName: 'B', descriptionPlain: FEE }, ingest, deps);
    expect(ingested.fraudFlags).toBeNull();
    deps.repo.jobs.set('job_9', cnJob({ id: 'job_9', descriptionPlain: FEE, fraudFlags: null }));
    await cnAfterEnrich({ ...cnJob({ id: 'job_9', descriptionPlain: FEE, fraudFlags: null }) } as never, enrich, deps);
    expect(deps.repo.jobs.get('job_9')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'upfront_fee', method: 'keywords' })]);
  });

  it('a blacklist read failure alone keeps the keyword flags (the cleared set is known)', async () => {
    const deps = fakeDeps();
    deps.store.blacklistCached = async () => {
      throw new Error('db down');
    };
    const out = await cnAfterNormalize({ market: 'cn', title: '客服', companyName: 'B', descriptionPlain: FEE }, ingest, deps);
    expect(out.fraudFlags).toEqual([expect.objectContaining({ rule: 'upfront_fee', method: 'keywords' })]);
  });

  it('intl jobs pass through untouched', async () => {
    const job = { market: 'intl' as const, title: 'x', descriptionPlain: FEE };
    expect(await cnAfterNormalize(job, { ...ingest, market: 'intl' }, fakeDeps())).toBe(job);
  });
});

describe('afterEnrich', () => {
  it('persists flags and tags, keeps other modules’ flags, and does not queue the LLM when a rule fired', async () => {
    const deps = fakeDeps({ env: CN_MODEL_ENV });
    deps.repo.jobs.set('job_1', cnJob({ descriptionPlain: FEE }));
    const intl = { rule: 'intl_fee_required', evidence: 'x', at: '2026-01-01T00:00:00Z' };
    await cnAfterEnrich({ ...cnJob({ descriptionPlain: `${FEE}面向2026届。` }), fraudFlags: [intl] }, enrich, deps);
    const saved = deps.repo.jobs.get('job_1')!;
    expect(saved.fraudFlags).toEqual([intl, expect.objectContaining({ rule: 'upfront_fee' })]);
    expect(saved.marketTags).toEqual([expect.objectContaining({ tag: 'class_year:2026' })]);
    expect(deps.enqueued).toEqual([]);
  });

  it('re-reads the posting tags on the stored row: a tag the posting no longer states is dropped, enrichment’s own tags stay', async () => {
    const deps = fakeDeps();
    const hukou = { tag: 'hukou', evidenceQuote: '可落户上海', evidenceUrl: null };
    const stale = [
      hukou,
      { tag: 'cn_hire:social', evidenceQuote: '社招', evidenceUrl: null },
      { tag: 'apply_closes:2026-10-01', evidenceQuote: '网申截止时间：2026年10月1日', evidenceUrl: null },
    ];
    deps.repo.jobs.set('job_1', cnJob({ descriptionPlain: '负责后端开发。', marketTags: stale }));
    await cnAfterEnrich({ ...cnJob({ descriptionPlain: '本岗位校招。\n网申截止时间：2026年11月30日。' }), marketTags: stale }, enrich, deps);
    expect((deps.repo.jobs.get('job_1')!.marketTags as Array<{ tag: string }>).map((t) => t.tag)).toEqual(['hukou', 'cn_hire:campus', 'apply_closes:2026-11-30']);
  });

  it('queues the LLM check for gray wording with no flag, only when a model is configured (a CN model, or the shared one: D5)', async () => {
    const gray = cnJob({ descriptionPlain: '宝妈兼职，时间自由，日结。' });
    const noModel = fakeDeps();
    await cnAfterEnrich(gray, enrich, noModel);
    expect(noModel.enqueued).toEqual([]);
    const withModel = fakeDeps({ env: CN_MODEL_ENV });
    await cnAfterEnrich(gray, enrich, withModel);
    expect(withModel.enqueued).toEqual(['job_1']);
    expect(withModel.enqueuedHashes[0]).toMatch(/^[0-9a-f]{40}$/);
    // No CN_ value at all: the shared model runs the second opinion.
    const shared = fakeDeps({ env: SHARED_MODEL_ENV });
    await cnAfterEnrich(gray, enrich, shared);
    expect(shared.enqueued).toEqual(['job_1']);
    // The domestic-only wall refuses the shared model: nothing is queued.
    const walled = fakeDeps({ env: { ...SHARED_MODEL_ENV, CN_LLM_DOMESTIC_ONLY: 'true' } });
    await cnAfterEnrich(gray, enrich, walled);
    expect(walled.enqueued).toEqual([]);
    // Plain postings never cost an LLM call.
    const plain = fakeDeps({ env: CN_MODEL_ENV });
    await cnAfterEnrich(cnJob(), enrich, plain);
    expect(plain.enqueued).toEqual([]);
    expect(plain.repo.saves).toEqual([]);
  });

  it('one LLM check per posting content: an edited posting is checked again', async () => {
    const deps = fakeDeps({ env: CN_MODEL_ENV });
    await cnAfterEnrich(cnJob({ descriptionPlain: '宝妈兼职，时间自由，日结。' }), enrich, deps);
    await cnAfterEnrich(cnJob({ descriptionPlain: '宝妈兼职，时间自由，日结。' }), enrich, deps);
    await cnAfterEnrich(cnJob({ descriptionPlain: '宝妈兼职，时间自由，日结，需垫付。' }), enrich, deps);
    const keys = deps.enqueuedHashes.map((h) => fraudCheckDedupeKey('job_1', h));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).toMatch(/^cn\.jobs\.fraudCheck:job_1:[0-9a-f]{40}$/);
  });

  it('a flag an admin cleared is never raised again for the same evidence', async () => {
    const deps = fakeDeps();
    const job = cnJob({ descriptionPlain: FEE });
    deps.repo.jobs.set(job.id, job);
    deps.store.reviews.push({ jobId: job.id, decision: 'clear', note: null, at: NOW.toISOString(), by: 'admin', clearedKeys: [flagKey({ rule: 'upfront_fee', evidence: FEE })] });
    await cnAfterEnrich(job, enrich, deps);
    expect(deps.repo.saves).toEqual([]);
  });

  it('skips archived and intl jobs', async () => {
    const deps = fakeDeps();
    await cnAfterEnrich(cnJob({ descriptionPlain: FEE, archivedAt: NOW }), enrich, deps);
    await cnAfterEnrich({ ...cnJob({ descriptionPlain: FEE }), market: 'intl' }, enrich, deps);
    expect(deps.repo.saves).toEqual([]);
  });
});

describe('LLM check worker', () => {
  const lure = cnJob({ descriptionPlain: '招聘线上推广员，时间自由。完成平台任务即可获得佣金，需先垫付任务金额。' });

  it('flags with a verified quote, drops invented quotes and unknown rules, logs cost', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        flags: [
          { rule: 'telecom_lure', quote: '完成平台任务即可获得佣金，需先垫付任务金额。' },
          { rule: 'upfront_fee', quote: '交2000元保证金' },
          { rule: 'pyramid', quote: '时间自由' },
        ],
      }),
    );
    const deps = fakeDeps({ env: CN_MODEL_ENV, llm, repo: fakeRepo([lure]) });
    const out = await runFraudCheck('job_1', deps, 'req-1');
    expect(out).toEqual({ status: 'checked', flagged: 1, model: 'deepseek/deepseek-chat' });
    expect(deps.repo.jobs.get('job_1')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'telecom_lure', method: 'llm' })]);
    expect(deps.repo.costs).toHaveLength(1);
    const [, options] = llm.chatWithUsage.mock.calls[0]!;
    expect(options).toMatchObject({ model: 'deepseek/deepseek-chat', provider: 'deepseek', temperature: 0, carriesUserData: false });
  });

  it('no model configured anywhere → no call; own import without AI consent → zero LLM calls', async () => {
    const llm = fakeLlm();
    expect(await runFraudCheck('job_1', fakeDeps({ llm, repo: fakeRepo([lure]) }))).toEqual({ status: 'skipped', reason: 'unavailable' });
    const own = cnJob({ ...lure, visibility: 'private', ownerUserId: 'u1' });
    const deps = fakeDeps({ env: CN_MODEL_ENV, llm, repo: fakeRepo([own]), aiAllowed: async () => false });
    expect(await runFraudCheck('job_1', deps)).toEqual({ status: 'skipped', reason: 'no_ai_consent' });
    expect(llm.chatWithUsage).not.toHaveBeenCalled();
  });

  it('the second opinion runs on the shared model when GoApply has no model of its own (D5)', async () => {
    const llm = fakeLlm('{"flags":[{"rule":"telecom_lure","quote":"需先垫付任务金额"}]}');
    const deps = fakeDeps({ env: SHARED_MODEL_ENV, llm, repo: fakeRepo([lure]) });
    expect(await runFraudCheck('job_1', deps)).toMatchObject({ status: 'checked', flagged: 1 });
    const options = llm.chatWithUsage.mock.calls[0]![1];
    expect(options).toMatchObject({ model: SHARED_MODEL_ENV.LLM_MODEL, carriesUserData: false });
    // Not a mainland prefix: no provider is forced, the model layer routes it as it does for RoboApply.
    expect(options).not.toHaveProperty('provider');
    // The flag is stored like any other.
    expect(deps.repo.jobs.get('job_1')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'telecom_lure', method: 'llm' })]);
  });

  it('a non-domestic model id is refused only under the domestic-only wall (CN_LLM_DOMESTIC_ONLY or CN_RESIDENCY_STRICT)', async () => {
    for (const wall of [{ CN_LLM_DOMESTIC_ONLY: 'true' }, { CN_RESIDENCY_STRICT: 'true' }]) {
      for (const model of [{ CN_LLM_MODEL: 'openrouter/openai/gpt-5' }, SHARED_MODEL_ENV, { LLM_MODEL: 'deepseek-chat' }]) {
        const llm = fakeLlm();
        const deps = fakeDeps({ env: { ...model, ...wall }, llm, repo: fakeRepo([lure]) });
        expect(await runFraudCheck('job_1', deps), JSON.stringify({ ...model, ...wall })).toEqual({ status: 'skipped', reason: 'unavailable' });
        expect(llm.chatWithUsage).not.toHaveBeenCalled();
      }
    }
    // Under the wall a mainland model still runs.
    const llm = fakeLlm();
    await runFraudCheck('job_1', fakeDeps({ env: { ...CN_MODEL_ENV, CN_LLM_DOMESTIC_ONLY: 'true' }, llm, repo: fakeRepo([lure]) }));
    expect(llm.chatWithUsage.mock.calls[0]![1]).toMatchObject({ model: 'deepseek/deepseek-chat', provider: 'deepseek' });
    // Without the wall the same non-domestic CN model is used as named.
    const open = fakeLlm();
    await runFraudCheck('job_1', fakeDeps({ env: { CN_LLM_MODEL: 'openrouter/openai/gpt-5' }, llm: open, repo: fakeRepo([lure]) }));
    expect(open.chatWithUsage.mock.calls[0]![1]).toMatchObject({ model: 'openrouter/openai/gpt-5' });
  });

  it('model order: the fraud model, then the enrichment model, then the default; a CN_ value wins over the shared one, key by key', () => {
    expect(resolveFraudModel({})).toEqual({ model: undefined, available: false });
    expect(resolveFraudModel(SHARED_MODEL_ENV)).toEqual({ model: SHARED_MODEL_ENV.LLM_MODEL, available: true });
    expect(resolveFraudModel({ ...SHARED_MODEL_ENV, LLM_ENRICH_MODEL: 'openrouter/google/gemini-3.8-flash' }).model).toBe('openrouter/google/gemini-3.8-flash');
    expect(resolveFraudModel({ ...SHARED_MODEL_ENV, LLM_ENRICH_MODEL: 'x/enrich', LLM_FRAUD_MODEL: 'x/fraud' }).model).toBe('x/fraud');
    expect(resolveFraudModel({ ...SHARED_MODEL_ENV, CN_LLM_MODEL: 'deepseek/deepseek-chat' })).toEqual({ model: 'deepseek/deepseek-chat', provider: 'deepseek', available: true });
    expect(resolveFraudModel({ ...SHARED_MODEL_ENV, LLM_FRAUD_MODEL: 'x/fraud', CN_LLM_FRAUD_MODEL: 'kimi/moonshot-v1-8k' })).toEqual({ model: 'kimi/moonshot-v1-8k', provider: 'kimi', available: true });
    expect(resolveFraudModel({ ...SHARED_MODEL_ENV, CN_LLM_DOMESTIC_ONLY: 'true' })).toEqual({ model: undefined, available: false, refused: 'not_domestic_provider' });
    expect(resolveFraudModel({ CN_LLM_DOMESTIC_ONLY: 'true' })).toEqual({ model: undefined, available: false });
  });

  it('GoApply with its own LLM stack never passes a shared model id to its own provider', () => {
    // A CN provider and a shared task model: the shared id is not used; the call names no model (the model layer picks GoApply's default).
    const own = { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' };
    expect(resolveFraudModel({ ...own, ...SHARED_MODEL_ENV, LLM_FRAUD_MODEL: 'openrouter/x/fraud', LLM_ENRICH_MODEL: 'openrouter/x/enrich' })).toEqual({ model: undefined, available: true });
    // Its own names still apply, in the same order.
    expect(resolveFraudModel({ ...own, ...SHARED_MODEL_ENV, CN_LLM_MODEL: 'deepseek/deepseek-chat' })).toEqual({ model: 'deepseek/deepseek-chat', provider: 'deepseek', available: true });
    expect(resolveFraudModel({ ...own, CN_LLM_MODEL: 'deepseek/deepseek-chat', CN_LLM_ENRICH_MODEL: 'kimi/moonshot-v1-8k', LLM_FRAUD_MODEL: 'openrouter/x/fraud' }).model).toBe('kimi/moonshot-v1-8k');
  });

  it('under the wall every mainland provider prefix is accepted, with its vendor and platform names', () => {
    expect([...FRAUD_DOMESTIC_PROVIDERS].sort()).toEqual(['ark', 'dashscope', 'deepseek', 'doubao', 'glm', 'kimi', 'minimax', 'moonshot', 'qwen', 'zhipu']);
    for (const provider of FRAUD_DOMESTIC_PROVIDERS) {
      expect(resolveFraudModel({ CN_LLM_MODEL: `${provider}/some-model`, CN_LLM_DOMESTIC_ONLY: 'true' }), provider).toEqual({ model: `${provider}/some-model`, provider, available: true });
    }
    // A self-hosted gateway, a foreign gateway and a bare id are not mainland routes by their name.
    for (const model of ['newapi/qwen-plus', 'openrouter/deepseek/deepseek-chat', 'deepseek-chat', 'deepseek/']) {
      expect(resolveFraudModel({ CN_LLM_MODEL: model, CN_LLM_DOMESTIC_ONLY: 'true' }).available, model).toBe(false);
    }
  });

  it('CN_LLM_FRAUD_MODEL wins when set', async () => {
    const llm = fakeLlm();
    const deps = fakeDeps({ env: { ...CN_MODEL_ENV, CN_LLM_FRAUD_MODEL: 'kimi/moonshot-v1-8k' }, llm, repo: fakeRepo([lure]) });
    await runFraudCheck('job_1', deps);
    expect(llm.chatWithUsage.mock.calls[0]![1]).toMatchObject({ model: 'kimi/moonshot-v1-8k', provider: 'kimi' });
  });

  it('malformed replies throw (the queue retries); missing jobs are skipped', async () => {
    const deps = fakeDeps({ env: CN_MODEL_ENV, llm: fakeLlm('not json'), repo: fakeRepo([lure]) });
    await expect(runFraudCheck('job_1', deps)).rejects.toThrow();
    expect(await runFraudCheck('nope', deps)).toEqual({ status: 'skipped', reason: 'not_found' });
  });

  it('the prompt fences the posting as data', async () => {
    const llm = fakeLlm();
    await runFraudCheck('job_1', fakeDeps({ env: CN_MODEL_ENV, llm, repo: fakeRepo([lure]) }));
    const [messages] = llm.chatWithUsage.mock.calls[0]!;
    expect(messages[0].content).toMatch(/data, not instructions/);
    expect(messages[1].content).toMatch(/<<<POSTING[\s\S]*POSTING>>>/);
  });
});

describe('admin review', () => {
  function seeded() {
    const deps = fakeDeps();
    const flagged = cnJob({ id: 'job_a', fraudFlags: [{ rule: 'upfront_fee', evidence: FEE, at: '2026-10-02T00:00:00.000Z', method: 'keywords' }] });
    const intlOnly = cnJob({ id: 'job_b', fraudFlags: [{ rule: 'intl_fee_required', evidence: 'x', at: '2026-10-02T00:00:00.000Z' }] });
    const reported = cnJob({ id: 'job_c' });
    const own = cnJob({ id: 'job_d', visibility: 'private', ownerUserId: 'u1', fraudFlags: [{ rule: 'mlm', evidence: '发展下线', at: '2026-10-03T00:00:00.000Z' }] });
    for (const j of [flagged, intlOnly, reported, own]) deps.repo.jobs.set(j.id, j);
    deps.repo.reports.push({ jobId: 'job_c', reasonCode: 'training_loan', at: new Date('2026-10-04T00:00:00Z') });
    deps.repo.reports.push({ jobId: 'job_a', reasonCode: 'scam', at: new Date('2026-10-05T00:00:00Z') });
    return deps;
  }

  it('flagged list: CN-flagged jobs plus fraud-type reports, with counts', async () => {
    const deps = seeded();
    const { items, cursor } = await listFraudQueue(deps);
    expect(items.map((i) => i.jobId).sort()).toEqual(['job_a', 'job_c', 'job_d']);
    const a = items.find((i) => i.jobId === 'job_a')!;
    expect(a).toMatchObject({ reportCount: 1, flaggedAt: '2026-10-02T00:00:00.000Z', sourceName: 'GoHire', visibility: 'public', review: null });
    expect(items.find((i) => i.jobId === 'job_d')!.visibility).toBe('private');
    expect(cursor).toBeNull();
  });

  it('clear removes the CN flags, keeps the evidence in the review, and lists it under cleared', async () => {
    const deps = seeded();
    expect(await resolveFraud(deps, 'job_a', { decision: 'clear', note: '正常押金退还说明' }, 'admin_1')).toEqual({ jobId: 'job_a', status: 'cleared', blacklistEntryId: null });
    expect(deps.repo.jobs.get('job_a')!.fraudFlags).toBeNull();
    const cleared = await listFraudQueue(deps, 'cleared');
    expect(cleared.items).toEqual([expect.objectContaining({ jobId: 'job_a', flags: [expect.objectContaining({ rule: 'upfront_fee' })], review: expect.objectContaining({ decision: 'clear', by: 'admin_1' }) })]);
    expect((await listFraudQueue(deps)).items.map((i) => i.jobId)).not.toContain('job_a');
    // A cleared reported-only job stays off the flagged list.
    await resolveFraud(deps, 'job_c', { decision: 'clear' }, 'admin_1');
    expect((await listFraudQueue(deps)).items.map((i) => i.jobId)).toEqual(['job_d']);
  });

  it('confirm archives an indexed posting and can blacklist the employer, flagging its other open jobs', async () => {
    const deps = seeded();
    const sibling = cnJob({ id: 'job_e', companyName: '示例科技有限公司' });
    deps.repo.jobs.set(sibling.id, sibling);
    const out = await resolveFraud(deps, 'job_a', { decision: 'confirm', note: '多名用户举报收押金', blacklistEmployer: true }, 'admin_1');
    expect(out.status).toBe('confirmed');
    expect(out.blacklistEntryId).toBeTruthy();
    expect(deps.repo.jobs.get('job_a')!.archivedAt).toEqual(NOW);
    expect(deps.repo.jobs.get('job_e')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'blacklisted_employer', method: 'blacklist' })]);
    expect((await listFraudQueue(deps, 'confirmed')).items.map((i) => i.jobId)).toEqual(['job_a']);
  });

  it("confirm keeps a user's own import (with its warning) and moves it from 'To review' to 'Confirmed'", async () => {
    const deps = seeded();
    await resolveFraud(deps, 'job_d', { decision: 'confirm' }, 'admin_1');
    expect(deps.repo.jobs.get('job_d')!.archivedAt).toBeNull();
    expect(deps.repo.jobs.get('job_d')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'mlm' })]);
    expect((await listFraudQueue(deps)).items.map((i) => i.jobId)).not.toContain('job_d');
    expect((await listFraudQueue(deps, 'confirmed')).items.map((i) => i.jobId)).toEqual(['job_d']);
  });

  it('a confirmed own import comes back to review only when a newer flag is raised', async () => {
    const deps = seeded();
    await resolveFraud(deps, 'job_d', { decision: 'confirm' }, 'admin_1');
    const job = deps.repo.jobs.get('job_d')!;
    job.fraudFlags = [...(job.fraudFlags as unknown[]), { rule: 'gambling', evidence: '博彩', at: '2026-10-11T00:00:00.000Z', method: 'keywords' }];
    expect((await listFraudQueue(deps)).items.map((i) => i.jobId)).toContain('job_d');
  });

  it("reviewed items carry the admin's name or email, never only the id", async () => {
    const deps = seeded();
    deps.repo.users.set('admin_1', 'Lin Wei');
    await resolveFraud(deps, 'job_a', { decision: 'clear' }, 'admin_1');
    await resolveFraud(deps, 'job_c', { decision: 'clear' }, 'admin_gone');
    const items = (await listFraudQueue(deps, 'cleared')).items;
    expect(items.find((i) => i.jobId === 'job_a')!.review).toMatchObject({ by: 'admin_1', byName: 'Lin Wei' });
    expect(items.find((i) => i.jobId === 'job_c')!.review).toMatchObject({ by: 'admin_gone', byName: null });
  });

  it('errors: unknown or intl job → not_found; blacklist on clear → invalid_request', async () => {
    const deps = seeded();
    await expect(resolveFraud(deps, 'missing', { decision: 'clear' }, 'a')).rejects.toMatchObject({ code: 'not_found' });
    deps.repo.jobs.set('intl', cnJob({ id: 'intl', market: 'intl' }));
    await expect(resolveFraud(deps, 'intl', { decision: 'clear' }, 'a')).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveFraud(deps, 'job_a', { decision: 'clear', blacklistEmployer: true }, 'a')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('paginates flagged jobs by id', async () => {
    const deps = fakeDeps();
    for (let i = 0; i < 55; i += 1) {
      const id = `job_${String(i).padStart(3, '0')}`;
      deps.repo.jobs.set(id, cnJob({ id, fraudFlags: [{ rule: 'gambling', evidence: '博彩', at: NOW.toISOString() }] }));
    }
    const first = await listFraudQueue(deps);
    expect(first.items).toHaveLength(50);
    expect(first.cursor).toBe('f:job_049');
    const second = await listFraudQueue(deps, 'flagged', first.cursor!);
    expect(second.items).toHaveLength(5);
    expect(second.cursor).toBeNull();
  });
});

describe('admin blacklist', () => {
  it('add (409 on duplicate), list, remove (unflags that employer’s jobs)', async () => {
    const deps = fakeDeps();
    const job = cnJob({ id: 'j1', companyName: '某某教育咨询有限公司' });
    deps.repo.jobs.set(job.id, job);
    const entry = await addToBlacklist(deps, { employerName: '某某教育咨询有限公司', reason: '培训贷' }, 'admin_1');
    expect(entry).toMatchObject({ employerName: '某某教育咨询有限公司', reason: '培训贷', createdBy: 'admin_1', matchedOpenJobs: 1 });
    expect(deps.repo.jobs.get('j1')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'blacklisted_employer' })]);
    await expect(addToBlacklist(deps, { employerName: '某某教育咨询 有限公司', reason: 'dup' }, 'admin_1')).rejects.toMatchObject({ code: 'conflict' });
    expect(await listBlacklist(deps)).toHaveLength(1);
    await removeFromBlacklist(deps, entry.id);
    expect(deps.repo.jobs.get('j1')!.fraudFlags).toBeNull();
    await expect(removeFromBlacklist(deps, entry.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('admin blacklist: short names', () => {
  it('a 2-3 character trade name matches company names that continue with a line of business', async () => {
    const deps = fakeDeps();
    for (const [id, companyName] of [
      ['j1', '华为技术有限公司'],
      ['j2', '上海鼎盛科技有限公司'],
      ['j3', '华为'],
      ['j4', '中华为民服务中心'],
    ] as const) {
      deps.repo.jobs.set(id, cnJob({ id, companyName }));
    }
    const hw = await addToBlacklist(deps, { employerName: '华为', reason: '冒用名义招聘' }, 'admin_1');
    expect(hw.matchedOpenJobs).toBe(2);
    expect(deps.repo.jobs.get('j1')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'blacklisted_employer' })]);
    expect(deps.repo.jobs.get('j3')!.fraudFlags).toEqual([expect.objectContaining({ rule: 'blacklisted_employer' })]);
    expect(deps.repo.jobs.get('j4')!.fraudFlags).toBeNull();
    const ds = await addToBlacklist(deps, { employerName: '鼎盛', reason: '培训贷' }, 'admin_1');
    expect(ds.matchedOpenJobs).toBe(1);
  });

  it('the add response says when nothing matched', async () => {
    const deps = fakeDeps();
    deps.repo.jobs.set('j1', cnJob({ id: 'j1', companyName: '示例科技有限公司' }));
    expect((await addToBlacklist(deps, { employerName: '不存在的公司', reason: 'r' }, 'admin_1')).matchedOpenJobs).toBe(0);
  });
});
