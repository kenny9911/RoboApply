// 一键填表 (WP-71): the supervised fill on mainland portal forms — the cn field
// map, values only from what the user entered, the three fill modes, and D1.

import { describe, expect, it, vi } from 'vitest';

import { beisenAdapter } from '../../src/adapters/cn/beisen';
import { dayeeAdapter } from '../../src/adapters/cn/dayee';
import { feishuAdapter } from '../../src/adapters/cn/feishu';
import { mokaAdapter } from '../../src/adapters/cn/moka';
import type { AtsAdapter } from '../../src/adapters/types';
import { FillSession, hasValue, type StartOptions } from '../../src/content/fill';
import type { ApiCall } from '../../src/shared/messages';
import { fakeApi, field } from '../helpers';
import { wireComboboxes } from './harness';
import { cnProfile, loadCnFixture } from './helpers';

const URLS: Record<string, string> = {
  moka: 'https://app.mokahr.com/campus-recruitment/example/12345#/job/abc/apply',
  beisen: 'https://example.zhiye.com/campus/jobs/apply?jobId=1',
  feishu: 'https://example.jobs.feishu.cn/campus/position/123/apply',
  dayee: 'https://wecruit.hotjob.cn/SU61234/pb/apply.html',
};

async function fill(adapter: AtsAdapter, fixture: string, opts: { profile?: ReturnType<typeof cnProfile>; start?: StartOptions; aiAvailable?: boolean; overrides?: Parameters<typeof fakeApi>[0] } = {}) {
  const doc = loadCnFixture(adapter.id, fixture);
  wireComboboxes(doc);
  const api = fakeApi(opts.overrides ?? {}, opts.profile ?? cnProfile());
  const s = new FillSession({ adapter, doc, url: URLS[adapter.id], api: api.api, jobId: 'job_cn', aiAvailable: opts.aiAvailable ?? true });
  await s.start(opts.start);
  return { s, api, doc };
}

function item(s: FillSession, id: string) {
  const it = s.getState().items.find((i) => i.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
}

describe('portal fill: values from the user only', () => {
  it('Moka campus: name family-first, 11-digit mobile, two education rows, optional details, resume', async () => {
    const { s, api } = await fill(mokaAdapter, 'campus');
    expect(field('#name').value).toBe('王小明');
    expect(field('#mobile').value).toBe('13800138000');
    expect(field('#email').value).toBe('xiaoming@example.test');
    expect(field('#nativePlace').value).toBe('湖南长沙');
    expect(field('#political').value).toBe('共青团员');
    expect(field('#studentOrigin').value).toBe('湖南');
    expect(field('#edu0_school').value).toBe('示例大学');
    expect(field('#edu0_degree').value).toBe('硕士研究生');
    expect(field('#edu0_major').value).toBe('计算机科学与技术');
    expect(field('#edu0_start').value).toBe('2023-09');
    expect(field('#edu0_end').value).toBe('2026-06');
    expect(field('#edu1_school').value).toBe('示例理工学院');
    expect(field('#edu1_degree').value).toBe('本科');
    expect(field('#edu1_end').value).toBe('2023-06');
    expect(field('#resume').files?.[0]?.name).toBe('Avery_Lin_Resume.pdf');

    expect(item(s, 'nativePlace')).toMatchObject({ status: 'filled', source: 'profile', sensitive: true, cnKey: 'nativePlace' });
    expect(item(s, 'studentOrigin')).toMatchObject({ status: 'filled', source: 'bank', sensitive: true });
    expect(item(s, 'name')).toMatchObject({ status: 'filled', source: 'profile' });
    expect(item(s, 'name').sensitive).toBeFalsy();
    // Personal details the profile does not hold: never guessed, never drafted.
    expect(field('#gender').value).toBe('');
    expect(item(s, 'gender')).toMatchObject({ status: 'needs_you', note: 'personal', personal: true, canDraft: false });
    expect(item(s, 'birthday')).toMatchObject({ status: 'skipped', note: 'personal', canDraft: false });
    expect(item(s, 'photo')).toMatchObject({ status: 'skipped', note: 'photo' });
    expect(api.ops()).toEqual(['createRun', 'autofillProfile', 'resumeForJob', 'fetchFile', 'patchRun']);
    expect(api.calls[0]).toMatchObject({ op: 'createRun', body: { host: 'app.mokahr.com', atsType: 'moka', fieldsTotal: 20 } });
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', body: { outcome: 'partial' } });
  });

  it('family rows come from the optional family details, row by row, never from the user', async () => {
    const { s } = await fill(mokaAdapter, 'social');
    expect(field('#s_name').value).toBe('王小明');
    expect(field<HTMLSelectElement>('#fm0_rel').selectedOptions[0].textContent).toBe('父亲');
    expect(field('#fm0_name').value).toBe('王某');
    expect(field('#fm0_org').value).toBe('示例机械厂');
    expect(field('#fm0_title').value).toBe('工程师');
    expect(field<HTMLSelectElement>('#fm1_rel').selectedOptions[0].textContent).toBe('母亲');
    expect(field('#fm1_name').value).toBe('李某');
    expect(item(s, 'fm1_name')).toMatchObject({ status: 'filled', sensitive: true, section: 'family' });
  });

  it('Dayee: a third family row without an entry stays empty and says why; table labels work', async () => {
    const { s } = await fill(dayeeAdapter, 'family');
    expect(field('#fam0_name').value).toBe('王某');
    expect(field('#fam1_org').value).toBe('示例小学');
    expect(field('#fam2_name').value).toBe('');
    expect(item(s, 'fam2_name')).toMatchObject({ status: 'skipped', note: 'family_none', canDraft: false });
    expect(field('#d_name').value).toBe('王小明');
  });

  it('without the autofill_sensitive consent (sensitive: null) 籍贯 / 政治面貌 / family stay empty', async () => {
    const profile = cnProfile({ sensitive: null, answers: [] });
    const { s } = await fill(dayeeAdapter, 'campus', { profile });
    expect(field('#nativePlace').value).toBe('');
    expect(field<HTMLSelectElement>('#political').value).toBe('');
    expect(field('#studentFrom').value).toBe('');
    // The details may exist but are off: the note says to turn them on, not to add them.
    expect(item(s, 'nativePlace')).toMatchObject({ status: 'skipped', note: 'sensitive_consent', canDraft: false });
    expect(item(s, 'political').canDraft).toBe(false);

    const fam = await fill(mokaAdapter, 'social', { profile });
    expect(field('#fm0_name').value).toBe('');
    expect(item(fam.s, 'fm0_name')).toMatchObject({ note: 'sensitive_consent', canDraft: false });
  });

  it('Dayee campus: native selects, yyyy-mm text dates, the 验证码 box is never listed', async () => {
    const { s } = await fill(dayeeAdapter, 'campus');
    expect(field<HTMLSelectElement>('#edu_degree').selectedOptions[0].textContent).toBe('硕士');
    expect(field<HTMLSelectElement>('#political').selectedOptions[0].textContent).toBe('共青团员');
    expect(field('#edu_start').value).toBe('2023-09');
    expect(field<HTMLSelectElement>('#sex').value).toBe('');
    expect(field('#birthday').value).toBe('');
    expect(s.getState().items.some((i) => i.id === 'checkCode')).toBe(false);
  });

  it('Beisen: month inputs, a read-only date picker is left for the user, internship rows and 到岗时间', async () => {
    const campus = await fill(beisenAdapter, 'campus');
    expect(field('#bs_start').value).toBe('2023-09');
    expect(field('#bs_end').value).toBe('2026-06');
    expect(field('#bs_birth').value).toBe('');
    expect(field('#bs_political').value).toBe('共青团员');
    expect(campus.doc.querySelectorAll<HTMLInputElement>('input[name="bs_gender"]:checked').length).toBe(0);

    const intern = await fill(beisenAdapter, 'intern');
    expect(field('#i_name').value).toBe('王小明');
    expect(field('#i_company').value).toBe('示例网络科技');
    expect(field('#i_post').value).toBe('后端开发实习生');
    expect(field('#i_from').value).toBe('2025年06月');
    expect(field('#i_to').value).toBe('2025年09月');
    expect(intern.doc.querySelector<HTMLInputElement>('input[name="i_days"][value="4"]')!.checked).toBe(true);
    expect(field('#i_avail').value).toBe('2026-03');
    // A free-text question that is not a personal detail can get a draft, shown only in the panel.
    expect(item(intern.s, 'i_why')).toMatchObject({ status: 'skipped', canDraft: true });
  });

  it('Feishu: type=month dates, 届 and internship selects; a date input that needs a day is not guessed', async () => {
    const { s } = await fill(feishuAdapter, 'campus');
    expect(field('#fs_grad').value).toBe('2026-06');
    expect(field('#fs_degree').value).toBe('硕士');
    const intern = await fill(feishuAdapter, 'intern');
    expect(field<HTMLSelectElement>('#fi_days').selectedOptions[0].textContent).toBe('4天');
    expect(field<HTMLSelectElement>('#fi_len').selectedOptions[0].textContent).toBe('6个月');
    expect(field('#fi_from').value).toBe('2025-06');
    expect(item(intern.s, 'fi_wechat')).toMatchObject({ status: 'skipped', note: 'no_value', canDraft: false });
    expect(s.getState().phase).toBe('done');
  });

  it('Feishu experienced: 民族 / 婚姻 / 身份证 are personal details (needs you, no draft, no AI call)', async () => {
    const { s, api } = await fill(feishuAdapter, 'experienced');
    for (const id of ['fe_ethnic', 'fe_marital', 'fe_id']) expect(item(s, id)).toMatchObject({ note: 'personal', canDraft: false });
    expect(field('#fe_id').value).toBe('');
    await s.requestDraft('fe_id');
    expect(api.ops()).not.toContain('answer');
    // The second experience row has no entry: left empty.
    expect(field('#fe0_company').value).toBe('示例网络科技');
    expect(field('#fe1_company').value).toBe('');
  });

  it('a personal detail fills from a saved answer to the same question (still flagged for review)', async () => {
    const profile = cnProfile({ answers: [{ questionKey: 'ethnicity', questionText: '民族', answer: '汉族' }] });
    const { s } = await fill(feishuAdapter, 'experienced', { profile });
    expect(field('#fe_ethnic').value).toBe('汉族');
    expect(item(s, 'fe_ethnic')).toMatchObject({ status: 'filled', source: 'bank', sensitive: true });
  });

  it('with AI off (consent or model unavailable) nothing is drafted and the AI endpoint is never called', async () => {
    const { s, api } = await fill(beisenAdapter, 'intern', { aiAvailable: false });
    expect(s.getState().items.every((i) => !i.canDraft)).toBe(true);
    for (const it of s.getState().items) await s.requestDraft(it.id);
    expect(api.ops()).not.toContain('answer');
  });
});

describe('fill modes', () => {
  it('只填空白 leaves a field that already holds something', async () => {
    const { s, api } = await fill(mokaAdapter, 'intern', { start: { mode: 'blank' } });
    expect(field('#f_email').value).toBe('old@example.test');
    expect(item(s, 'f_email')).toMatchObject({ status: 'skipped', note: 'has_value' });
    expect(field('#f_name').value).toBe('王小明');
    expect(s.getState().mode).toBe('blank');
    expect(api.calls[0]).toMatchObject({ op: 'createRun', body: { fieldsTotal: 14 } });
  });

  it('全部填写 overwrites what the form held (undo puts it back)', async () => {
    const { s } = await fill(mokaAdapter, 'intern', { start: { mode: 'all' } });
    expect(field('#f_email').value).toBe('xiaoming@example.test');
    s.undo();
    expect(field('#f_email').value).toBe('old@example.test');
  });

  it('填写选中区域 fills only the fields inside the selection and counts only those', async () => {
    const doc = loadCnFixture('moka', 'social');
    const family = doc.querySelectorAll('.section')[1]!;
    const inScope = (el: Element) => family.contains(el);
    const api = fakeApi({}, cnProfile());
    const s = new FillSession({ adapter: mokaAdapter, doc, url: URLS.moka, api: api.api, jobId: 'job_cn', aiAvailable: true });
    await s.start({ mode: 'selection', inScope });
    expect(field('#fm0_name').value).toBe('王某');
    expect(field('#s_name').value).toBe('');
    expect(s.getState().items.map((i) => i.id)).toEqual(['fm0_rel', 'fm0_name', 'fm0_org', 'fm0_title', 'fm1_rel', 'fm1_name', 'fm1_org', 'fm1_title']);
    expect(api.calls[0]).toMatchObject({ op: 'createRun', body: { fieldsTotal: 8 } });
  });

  it('填写选中区域: rows keep their place in the whole form (only the second member selected → the second entry)', async () => {
    const doc = loadCnFixture('moka', 'social');
    const second = doc.querySelectorAll('.family-row')[1]!;
    const api = fakeApi({}, cnProfile());
    const s = new FillSession({ adapter: mokaAdapter, doc, url: URLS.moka, api: api.api, jobId: 'job_cn', aiAvailable: true });
    await s.start({ mode: 'selection', inScope: (el) => second.contains(el) });
    expect(field('#fm1_name').value).toBe('李某');
    expect(field('#fm0_name').value).toBe('');
  });

  it('填写选中区域 with a real DOM selection (Range) works', async () => {
    const doc = loadCnFixture('dayee', 'campus');
    const range = doc.createRange();
    range.setStartBefore(doc.querySelector('#nativePlace')!);
    range.setEndAfter(doc.querySelector('#studentFrom')!);
    const api = fakeApi({}, cnProfile());
    const s = new FillSession({ adapter: dayeeAdapter, doc, url: URLS.dayee, api: api.api, jobId: null, aiAvailable: true });
    await s.start({ mode: 'selection', inScope: (el) => range.intersectsNode(el) });
    expect(s.getState().items.map((i) => i.id)).toEqual(['nativePlace', 'political', 'studentFrom']);
    expect(field('#nativePlace').value).toBe('湖南长沙');
    expect(field('#userName').value).toBe('');
  });

  it('填写选中区域 without a selection: an error, and nothing is reserved or read', async () => {
    const { s, api } = await fill(mokaAdapter, 'campus', { start: { mode: 'selection', inScope: null } });
    expect(s.getState()).toMatchObject({ phase: 'error', error: 'no_selection' });
    expect(api.calls).toEqual([]);
    expect(field('#name').value).toBe('');
  });

  it('填写选中区域 over a part with no fields: an error, and nothing is reserved', async () => {
    const { s, api } = await fill(mokaAdapter, 'campus', { start: { mode: 'selection', inScope: () => false } });
    expect(s.getState()).toMatchObject({ phase: 'error', error: 'no_fields_in_selection' });
    expect(api.calls).toEqual([]);
  });
});

describe('D1 on portal forms', () => {
  it('filling never presses a button or submits the form', async () => {
    const doc = loadCnFixture('moka', 'campus');
    wireComboboxes(doc);
    const submits = vi.fn();
    doc.addEventListener('submit', submits, true);
    const pressed = vi.fn();
    doc.querySelectorAll('button').forEach((b) => b.addEventListener('click', pressed));
    const api = fakeApi({}, cnProfile());
    const s = new FillSession({ adapter: mokaAdapter, doc, url: URLS.moka, api: api.api, jobId: 'job_cn', aiAvailable: true });
    await s.start();
    expect(submits).not.toHaveBeenCalled();
    expect(pressed).not.toHaveBeenCalled();
    const patch = api.calls.at(-1) as Extract<ApiCall, { op: 'patchRun' }>;
    expect(patch.body.userMarkedSubmitted).toBeUndefined();
  });
});

describe('hasValue', () => {
  it('reads text, selects (placeholder = empty), radios, files and custom selects', () => {
    const doc = loadCnFixture('moka', 'intern');
    const fields = mokaAdapter.listFields(doc);
    const get = (id: string) => fields.find((f) => f.id === id)!;
    expect(hasValue(get('f_email'))).toBe(true);
    expect(hasValue(get('f_name'))).toBe(false);
    expect(hasValue(get('f_days'))).toBe(false);
    (get('f_days').element as HTMLSelectElement).value = '4';
    expect(hasValue(get('f_days'))).toBe(true);
    expect(hasValue(get('f_resume'))).toBe(false);

    const campus = loadCnFixture('moka', 'campus');
    const cf = mokaAdapter.listFields(campus);
    const gender = cf.find((f) => f.id === 'gender')!;
    expect(hasValue(gender)).toBe(false);
    const shown = campus.createElement('span');
    shown.className = 'ant-select-selection-item';
    shown.textContent = '男';
    gender.element.closest('.ant-select-selector')!.appendChild(shown);
    expect(hasValue(gender)).toBe(true);
  });
});
