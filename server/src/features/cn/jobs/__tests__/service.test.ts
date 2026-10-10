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
import { CN_MODEL_ENV, NOW, cnJob, fakeDeps, fakeLlm, fakeRepo } from './testkit.js';
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

  it('queues the LLM check for gray wording with no flag, only when a CN model exists', async () => {
    const gray = cnJob({ descriptionPlain: '宝妈兼职，时间自由，日结。' });
    const noModel = fakeDeps();
    await cnAfterEnrich(gray, enrich, noModel);
    expect(noModel.enqueued).toEqual([]);
    const withModel = fakeDeps({ env: CN_MODEL_ENV });
    await cnAfterEnrich(gray, enrich, withModel);
    expect(withModel.enqueued).toEqual(['job_1']);
    expect(withModel.enqueuedHashes[0]).toMatch(/^[0-9a-f]{40}$/);
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

  it('no CN model → no call; own import without AI consent → zero LLM calls', async () => {
    const llm = fakeLlm();
    expect(await runFraudCheck('job_1', fakeDeps({ llm, repo: fakeRepo([lure]) }))).toEqual({ status: 'skipped', reason: 'unavailable' });
    const own = cnJob({ ...lure, visibility: 'private', ownerUserId: 'u1' });
    const deps = fakeDeps({ env: CN_MODEL_ENV, llm, repo: fakeRepo([own]), aiAllowed: async () => false });
    expect(await runFraudCheck('job_1', deps)).toEqual({ status: 'skipped', reason: 'no_ai_consent' });
    expect(llm.chatWithUsage).not.toHaveBeenCalled();
  });

  it('a non-domestic model id is refused (R-13)', async () => {
    const llm = fakeLlm();
    const deps = fakeDeps({ env: { CN_LLM_MODEL: 'openrouter/openai/gpt-5' }, llm, repo: fakeRepo([lure]) });
    expect(await runFraudCheck('job_1', deps)).toEqual({ status: 'skipped', reason: 'unavailable' });
    expect(llm.chatWithUsage).not.toHaveBeenCalled();
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
