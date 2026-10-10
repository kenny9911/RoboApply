// Review fixes (WP-71): another person's fields never get the user's details,
// every application form on the page is read (one form per section card, a
// search form in the header), repeated blocks under an unknown heading map row
// by row, grades and scores are never drafted, and the submit hint only looks
// at the form's own controls.

import { describe, expect, it } from 'vitest';

import { planCnFields, sectionKind } from '../../src/adapters/cn/fields';
import { beisenAdapter } from '../../src/adapters/cn/beisen';
import { dayeeAdapter } from '../../src/adapters/cn/dayee';
import { genericCnAdapter } from '../../src/adapters/cn/generic';
import { mokaAdapter } from '../../src/adapters/cn/moka';
import type { AtsAdapter, FieldHandle } from '../../src/adapters/types';
import { FillSession } from '../../src/content/fill';
import { findSubmitControl } from '../../src/content/panel/submitHint';
import { fakeApi, field } from '../helpers';
import { cnProfile, loadCnFixture } from './helpers';

async function fill(adapter: AtsAdapter, portal: string, fixture: string, url: string, profile = cnProfile()) {
  const doc = loadCnFixture(portal, fixture);
  const api = fakeApi({}, profile);
  const s = new FillSession({ adapter, doc, url, api: api.api, jobId: 'job_cn', aiAvailable: true });
  await s.start();
  const item = (id: string) => {
    const it = s.getState().items.find((i) => i.id === id);
    if (!it) throw new Error(`no item ${id} in [${s.getState().items.map((i) => i.id).join(', ')}]`);
    return it;
  };
  return { s, api, doc, item };
}

const BEISEN_URL = 'https://example.zhiye.com/campus/jobs/apply?jobId=9';
const MOKA_URL = 'https://app.mokahr.com/campus-recruitment/sample/1#/job/x/apply';
const DAYEE_URL = 'https://wecruit.hotjob.cn/SU1/pb/apply.html';

describe('section headings', () => {
  it('knows family, other-person, education and applicant headings', () => {
    expect(sectionKind('主要社会关系')).toBe('family');
    expect(sectionKind('家庭成员及主要社会关系')).toBe('family');
    expect(sectionKind('紧急联系人')).toBe('contact');
    expect(sectionKind('紧急联系人信息')).toBe('contact');
    expect(sectionKind('推荐人')).toBe('contact');
    expect(sectionKind('证明人')).toBe('contact');
    expect(sectionKind('学习经历')).toBe('education');
    expect(sectionKind('学历信息')).toBe('education');
    expect(sectionKind('报名信息')).toBe('basic');
    expect(sectionKind('联系方式')).toBe('basic');
    expect(sectionKind('补充信息')).toBe('other');
  });
});

describe('another person is never filled with the user details', () => {
  it('Beisen cards: 紧急联系人 stays empty and says why; 主要社会关系 rows come from the family details', async () => {
    const { item } = await fill(beisenAdapter, 'beisen', 'cards', BEISEN_URL);
    expect(field('#c_name').value).toBe('王小明');
    expect(field('#c_phone').value).toBe('13800138000');
    // 紧急联系人: someone else.
    expect(field('#ec_name').value).toBe('');
    expect(field('#ec_phone').value).toBe('');
    expect(field('#ec_rel').value).toBe('');
    expect(item('ec_name')).toMatchObject({ status: 'skipped', note: 'other_person', canDraft: false, section: 'contact' });
    expect(item('ec_phone')).toMatchObject({ note: 'other_person', canDraft: false });
    // 主要社会关系: family members, row by row.
    expect(field('#sr0_rel').value).toBe('父亲');
    expect(field('#sr0_name').value).toBe('王某');
    expect(field('#sr1_name').value).toBe('李某');
    expect(field('#sr1_org').value).toBe('示例小学');
    expect(item('sr0_name')).toMatchObject({ section: 'family', sensitive: true });
  });

  it('a referee block (证明人) and referee labels in an internship row are left for the user', async () => {
    const dayee = await fill(dayeeAdapter, 'dayee', 'search-header', DAYEE_URL);
    expect(field('#dh_name').value).toBe('王小明');
    expect(field('#dh_ref_name').value).toBe('');
    expect(field('#dh_ref_phone').value).toBe('');
    expect(dayee.item('dh_ref_name')).toMatchObject({ note: 'other_person', canDraft: false });

    const moka = await fill(mokaAdapter, 'moka', 'header-search', MOKA_URL);
    expect(field('#x_company').value).toBe('示例网络科技');
    expect(field('#x_ref').value).toBe('');
    expect(moka.item('x_ref')).toMatchObject({ note: 'other_person', canDraft: false });
    expect(moka.item('x_ref_phone')).toMatchObject({ note: 'other_person', canDraft: false });
  });

  it('under a heading the map does not know, 姓名 / 手机 asked again are not the user', async () => {
    const { item } = await fill(mokaAdapter, 'moka', 'header-search', MOKA_URL);
    expect(field('#m_name').value).toBe('王小明');
    expect(field('#o_name').value).toBe('');
    expect(field('#o_phone').value).toBe('');
    expect(item('o_name')).toMatchObject({ status: 'skipped', note: 'check_whose', canDraft: false });
  });

  it('without the optional-details consent, family rows say to turn it on (not to add them again)', async () => {
    const { item } = await fill(beisenAdapter, 'beisen', 'cards', BEISEN_URL, cnProfile({ sensitive: null }));
    expect(field('#sr0_name').value).toBe('');
    expect(item('sr0_name')).toMatchObject({ note: 'sensitive_consent', canDraft: false });
    expect(item('c_native')).toMatchObject({ note: 'sensitive_consent' });
  });

  it('with the consent but no entry for that row, family rows still say family_none', async () => {
    const profile = cnProfile();
    profile.sensitive = { cn: { familyMembers: [{ relation: '父亲', name: '王某', employer: '示例机械厂', title: '工程师' }] } };
    const { item } = await fill(beisenAdapter, 'beisen', 'cards', BEISEN_URL, profile);
    expect(field('#sr0_name').value).toBe('王某');
    expect(item('sr1_name')).toMatchObject({ note: 'family_none' });
  });
});

describe('every application form on the page, never a search form', () => {
  it('Beisen: one form per section card are all read; the search form above them is not', () => {
    const doc = loadCnFixture('beisen', 'cards');
    const ids = beisenAdapter.listFields(doc).map((f) => f.id);
    expect(ids).not.toContain('q');
    expect(ids).toEqual(expect.arrayContaining(['c_name', 'st0_school', 'st1_major', 'sr1_name', 'ec_phone', 'c_resume']));
    expect(beisenAdapter.cn.formRegions(doc)).toHaveLength(5);
  });

  it('Dayee: a keyword search form before #applyForm is skipped', () => {
    const doc = loadCnFixture('dayee', 'search-header');
    const fields = dayeeAdapter.listFields(doc);
    expect(fields.map((f) => f.id)).toEqual(['dh_name', 'dh_mobile', 'dh_email', 'dh_political', 'dh_ref_name', 'dh_ref_phone']);
  });

  it('Moka: an Ant Design search form in the nav bar is skipped', () => {
    const doc = loadCnFixture('moka', 'header-search');
    const ids = mokaAdapter.listFields(doc).map((f) => f.id);
    expect(ids[0]).toBe('m_name');
    expect(ids).not.toContain('kw');
  });

  it('generic: a <header><form> search does not hide the application form', async () => {
    const doc = loadCnFixture('generic', 'header-form');
    const ids = genericCnAdapter.listFields(doc).map((f) => f.id);
    expect(ids).toEqual(['g_name', 'g_phone', 'g_mail', 'g_school', 'g_degree']);
    const { s } = await fill(genericCnAdapter, 'generic', 'header-form', 'https://careers.example-games.cn/apply/2');
    expect(field('#g_name').value).toBe('王小明');
    expect(field('#g_school').value).toBe('示例大学');
    expect(s.getState().phase).toBe('done');
  });
});

describe('repeated blocks and scores', () => {
  it('学习经历 blocks map to the first and second degree', async () => {
    await fill(beisenAdapter, 'beisen', 'cards', BEISEN_URL);
    expect(field('#st0_school').value).toBe('示例大学');
    expect(field('#st1_school').value).toBe('示例理工学院');
    expect(field('#st1_major').value).toBe('软件工程');
  });

  it('a heading the map does not know (求学经历): repeated school fields still go row by row', () => {
    const doc = loadCnFixture('moka', 'header-search');
    const fields = mokaAdapter.listFields(doc);
    const plan = planCnFields(mokaAdapter, fields);
    const row = (id: string) => plan.get(fields.find((f) => f.id === id)!.id);
    expect(row('q0_school')).toMatchObject({ key: 'school', row: 0 });
    expect(row('q1_school')).toMatchObject({ key: 'school', row: 1 });
    expect(row('q1_major')).toMatchObject({ key: 'major', row: 1 });
  });

  it('grades and test scores are never offered an AI draft', async () => {
    const beisen = await fill(beisenAdapter, 'beisen', 'cards', BEISEN_URL);
    expect(field('#st0_gpa').value).toBe('');
    // Server protected type `grades` (WP-93): the user's own record, never drafted.
    expect(beisen.item('st0_gpa')).toMatchObject({ canDraft: false, note: 'protected', protectedType: 'grades' });
    const moka = await fill(mokaAdapter, 'moka', 'header-search', MOKA_URL);
    expect(moka.item('o_cet')).toMatchObject({ canDraft: false });
    expect(moka.api.ops()).not.toContain('answer');
  });
});

describe('成绩 / 排名 as work achievements are open questions', () => {
  const handle = (id: string, label: string): FieldHandle => {
    const el = document.createElement('textarea');
    el.id = id;
    document.body.appendChild(el);
    return { id, label, kind: 'textarea', required: false, element: el } as FieldHandle;
  };

  it('a study context (or the bare label) is a grade and is never drafted; an achievement question is left to the open-question path', () => {
    const fields = [
      handle('g1', '成绩'),
      handle('g2', '专业排名'),
      handle('g3', '大学期间取得的成绩'),
      handle('g4', '笔试分数'),
      handle('w1', '请描述你在上一份工作中取得的主要成绩'),
      handle('w2', '你在团队中的排名贡献是什么'),
    ];
    const plan = planCnFields(mokaAdapter, fields);
    for (const id of ['g1', 'g2', 'g3', 'g4']) expect(plan.get(id), id).toMatchObject({ key: null, noDraft: true });
    // Not owned by the portal map: the fill pass treats them as ordinary questions (a draft can be offered).
    expect(plan.has('w1')).toBe(false);
    expect(plan.has('w2')).toBe(false);
    for (const f of fields) f.element.remove();
  });
});

describe('submit hint looks only at the form', () => {
  it('Beisen cards: the 提交 in the bar after the forms, not the consent dialog 确认 or a footer link', () => {
    const el = findSubmitControl(loadCnFixture('beisen', 'cards'), beisenAdapter);
    expect(el?.textContent?.trim()).toBe('提交');
    expect(el?.closest('.submit-bar')).toBeTruthy();
  });

  it('a footer link or a dialog is never the submit control, even with no button in the form', () => {
    const doc = loadCnFixture('beisen', 'cards');
    doc.querySelector('.submit-bar')!.remove();
    expect(findSubmitControl(doc, beisenAdapter)).toBeNull();
  });

  it('Dayee: the search form 搜索 button is not considered; the form 提交 is', () => {
    const el = findSubmitControl(loadCnFixture('dayee', 'search-header'), dayeeAdapter) as HTMLInputElement | null;
    expect(el?.id).toBe('btnSubmit');
  });

  it('generic: plain links are ignored even inside the form', () => {
    const doc = loadCnFixture('generic', 'header-form');
    const form = doc.querySelector('#apply')!;
    form.querySelector('button[type="submit"]')!.remove();
    const a = doc.createElement('a');
    a.href = '/apply/history';
    a.textContent = '投递记录';
    form.appendChild(a);
    expect(findSubmitControl(doc, genericCnAdapter)).toBeNull();
  });
});

describe('submit hint: a bar right after the form', () => {
  it('finds a 提交 in the block right after the form, not one further down the page', () => {
    const doc = loadCnFixture('generic', 'header-form');
    const form = doc.querySelector('#apply')!;
    form.querySelector('button[type="submit"]')!.closest('p')!.remove();
    const bar = doc.createElement('div');
    bar.innerHTML = '<button type="button">提交</button>';
    form.after(bar);
    expect(findSubmitControl(doc, genericCnAdapter)).toBe(bar.querySelector('button'));
    bar.remove();
    const far = doc.createElement('section');
    far.innerHTML = '<div>a</div>';
    form.after(far, doc.createElement('div'), doc.createElement('div'), bar);
    expect(findSubmitControl(doc, genericCnAdapter)).toBeNull();
  });
});

describe('a form without headings', () => {
  it('a second 姓名 is not the user, a second phone field still is', async () => {
    document.body.innerHTML = `<form id="apply">
      <p><label for="n1">姓名</label><input id="n1"></p>
      <p><label for="p1">手机</label><input id="p1"></p>
      <p><label for="p2">联系电话</label><input id="p2"></p>
      <p><label for="m1">邮箱</label><input id="m1"></p>
      <p><label for="s1">学校</label><input id="s1"></p>
      <p><label for="n2">姓名</label><input id="n2"></p>
    </form>`;
    const api = fakeApi({}, cnProfile());
    const s = new FillSession({ adapter: genericCnAdapter, doc: document, url: 'https://careers.example.cn/apply', api: api.api, jobId: null, aiAvailable: true });
    await s.start();
    expect(field('#n1').value).toBe('王小明');
    expect(field('#p2').value).toBe('13800138000');
    expect(field('#n2').value).toBe('');
    expect(s.getState().items.find((i) => i.id === 'n2')).toMatchObject({ note: 'check_whose', canDraft: false });
  });
});
