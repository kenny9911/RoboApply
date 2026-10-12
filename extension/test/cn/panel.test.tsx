// The GoApply panel (一键填表): three fill modes, fill again for the next step,
// "请核对后自行提交" with the portal's submit control outlined, cn notes, and
// the AI label in the AiGeneratedBadge style. RoboApply's panel is unchanged.

import { act, configure, fireEvent, getConfig, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { greenhouseAdapter } from '../../src/adapters/intl/greenhouse';
import { beisenAdapter } from '../../src/adapters/cn/beisen';
import { mokaAdapter } from '../../src/adapters/cn/moka';
import type { AtsAdapter } from '../../src/adapters/types';
import { setBuildEnvForTests } from '../../src/env';
import { setLocale } from '../../src/i18n/index';
import { Panel } from '../../src/content/panel/Panel';
import { mountPanel } from '../../src/content/panel/mount';
import { SUBMIT_HINT_ATTR } from '../../src/content/panel/submitHint';
import { fail, fakeApi, field, loadFixture, ok } from '../helpers';
import { wireComboboxes } from './harness';
import { cnProfile, loadCnFixture } from './helpers';

const MOKA_URL = 'https://app.mokahr.com/campus-recruitment/example/12345#/job/abc/apply';
let restoreEnv: () => void = () => {};

// A fill awaits several fake API round-trips; under a loaded machine the 1 s default is too short.
let previousTimeout = 1000;
beforeAll(() => {
  previousTimeout = getConfig().asyncUtilTimeout;
  configure({ asyncUtilTimeout: 5000 });
});
afterAll(() => configure({ asyncUtilTimeout: previousTimeout }));

beforeEach(() => {
  restoreEnv = setBuildEnvForTests({ brand: 'goapply' });
  setLocale('zh');
});
afterEach(() => {
  restoreEnv();
  setLocale(null);
});

const cnMe = () => ok({ user: { id: 'u_cn', email: null, firstName: '小明' }, brand: { id: 'goapply', name: 'GoApply' }, entitlements: null, flags: { aiAnswers: true }, profileCompleteness: 70 });

function renderCn(opts: { adapter?: AtsAdapter; fixture?: [string, string]; url?: string; api?: ReturnType<typeof fakeApi> } = {}) {
  const [portal, name] = opts.fixture ?? ['moka', 'campus'];
  const doc = loadCnFixture(portal, name);
  wireComboboxes(doc);
  const api = opts.api ?? fakeApi({ me: cnMe, pageJob: () => ok({ jobId: 'job_cn' }) }, cnProfile());
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<Panel adapter={opts.adapter ?? mokaAdapter} doc={doc} url={opts.url ?? MOKA_URL} api={api.api} webOrigin="https://www.goapply.top" market="cn" onCollapse={() => {}} />, { container: host });
  return { api, doc, panel: within(host) };
}

describe('GoApply panel', () => {
  it('offers 全部填写 / 只填空白 / 填写选中区域 instead of one button', async () => {
    const { panel } = renderCn();
    expect(await panel.findByText('一键填表')).toBeTruthy();
    expect(await panel.findByRole('button', { name: '全部填写' })).toBeTruthy();
    expect(panel.getByRole('button', { name: '只填空白' })).toBeTruthy();
    expect(panel.getByRole('button', { name: '填写选中区域' })).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Fill this form' })).toBeNull();
    expect(panel.getByText('先在页面上选中要填写的部分。')).toBeTruthy();
  });

  it('全部填写: fills, says 请核对后自行提交, outlines the portal submit control, never presses it', async () => {
    const { panel, doc, api } = renderCn();
    const pressed: string[] = [];
    doc.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => pressed.push(b.textContent ?? '')));
    fireEvent.click(await panel.findByRole('button', { name: '全部填写' }));
    expect(await panel.findByText('请核对后自行提交')).toBeTruthy();
    expect(field('#name').value).toBe('王小明');
    const outlined = await waitFor(() => { const el = doc.querySelector(`[${SUBMIT_HINT_ATTR}]`); if (!el) throw new Error('no outline'); return el; });
    expect(outlined?.textContent).toBe('提交申请');
    expect(panel.getByText('已在页面上标出表单自己的提交按钮。尚未提交任何内容。')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: '定位提交按钮' }));
    expect(pressed).toEqual([]);
    expect(api.ops()).toContain('patchRun');
    // The personal detail is explained in the cn namespace.
    const gender = panel.getByText('性别').closest('li')!;
    expect(within(gender as HTMLElement).getByText('个人信息，请自行填写。')).toBeTruthy();
    // Optional details are flagged for review.
    const native = panel.getByText('籍贯').closest('li')!;
    expect(within(native as HTMLElement).getByText('来自你填写的选填信息，提交前请核对。')).toBeTruthy();
    // The modes come back for the next step of the form.
    expect(panel.getByText('再次填写（例如表单的下一步）')).toBeTruthy();
  });

  it('works with the job lookup off (recruitment-info mode off): fills without a job and still says 请核对后自行提交', async () => {
    const api = fakeApi({ me: cnMe, pageJob: () => fail('feature_disabled', 403) }, cnProfile());
    const { panel } = renderCn({ api });
    fireEvent.click(await panel.findByRole('button', { name: '全部填写' }));
    expect(await panel.findByText('请核对后自行提交')).toBeTruthy();
    expect(field('#name').value).toBe('王小明');
    expect(api.ops()).toContain('pageJob');
    const run = api.calls.find((c) => c.op === 'createRun') as { body: { jobId?: string } } | undefined;
    expect(run).toBeTruthy();
    expect(run!.body.jobId).toBeUndefined();
    expect(api.ops()).toContain('patchRun');
  });

  it('a step with only 下一步: no outline, and the review line still says the user submits', async () => {
    const { panel, doc } = renderCn({ fixture: ['moka', 'social'] });
    fireEvent.click(await panel.findByRole('button', { name: '全部填写' }));
    expect(await panel.findByText('请核对后自行提交')).toBeTruthy();
    expect(panel.getByText('填完后请使用表单自己的按钮。尚未提交任何内容。')).toBeTruthy();
    expect(doc.querySelector(`[${SUBMIT_HINT_ATTR}]`)).toBeNull();
    expect(panel.queryByRole('button', { name: '定位提交按钮' })).toBeNull();
  });

  it('只填空白 keeps what the form already held', async () => {
    const { panel } = renderCn({ fixture: ['moka', 'intern'], url: 'https://app.mokahr.com/apply/sample/678#/job/def' });
    fireEvent.click(await panel.findByRole('button', { name: '只填空白' }));
    await panel.findByText('请核对后自行提交');
    expect(field('#f_email').value).toBe('old@example.test');
    const email = panel.getByText('邮箱').closest('li')!;
    expect(within(email as HTMLElement).getByText('表单里已有内容，保持不变。')).toBeTruthy();
  });

  it('填写选中区域 uses the selection taken when the button is pressed; without one it explains and charges nothing', async () => {
    const { panel, doc, api } = renderCn({ fixture: ['moka', 'social'] });
    const button = await panel.findByRole('button', { name: '填写选中区域' });
    doc.getSelection()?.removeAllRanges();
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(await panel.findByText('请先在页面上选中要填写的部分，再试一次。')).toBeTruthy();
    expect(api.ops()).not.toContain('createRun');

    const range = doc.createRange();
    range.selectNodeContents(doc.querySelectorAll('.section')[1]!);
    doc.getSelection()!.removeAllRanges();
    doc.getSelection()!.addRange(range);
    fireEvent.mouseDown(panel.getByRole('button', { name: '填写选中区域' }));
    fireEvent.click(panel.getByRole('button', { name: '填写选中区域' }));
    await panel.findByText('请核对后自行提交');
    expect(field('#fm0_name').value).toBe('王某');
    expect(field('#s_name').value).toBe('');
    expect(api.calls.find((c) => c.op === 'createRun')).toMatchObject({ body: { atsType: 'moka', fieldsTotal: 8 } });
  });

  it('an AI draft carries the AiGeneratedBadge-style label and stays in the panel until 使用', async () => {
    const api = fakeApi({ me: cnMe, pageJob: () => ok({ jobId: 'job_cn' }), answer: () => ok({ answer: '我希望在投行业务中积累经验。', source: 'ai', saveable: true }) }, cnProfile());
    const { panel } = renderCn({ adapter: beisenAdapter, fixture: ['beisen', 'intern'], url: 'https://sample.zhiye.com/intern/apply/2', api });
    fireEvent.click(await panel.findByRole('button', { name: '全部填写' }));
    await panel.findByText('请核对后自行提交');
    const why = panel.getByText('为什么想加入我们').closest('li') as HTMLElement;
    fireEvent.click(within(why).getByRole('button', { name: 'Write a draft' }));
    await within(why).findByRole('textbox');
    const badge = within(why).getByText('AI 辅助生成');
    expect(badge.closest('[data-ai-label]')).toBeTruthy();
    expect(field<HTMLTextAreaElement>('#i_why').value).toBe('');
    await act(async () => {
      fireEvent.click(within(why).getByRole('button', { name: 'Use this answer' }));
    });
    await waitFor(() => expect(field<HTMLTextAreaElement>('#i_why').value).toBe('我希望在投行业务中积累经验。'));
  });

  it('the launcher says 一键填表 on GoApply', async () => {
    const doc = loadCnFixture('moka', 'campus');
    const api = fakeApi({ me: cnMe }, cnProfile());
    const mounted = mountPanel(doc, { adapter: mokaAdapter, doc, url: MOKA_URL, api: api.api, webOrigin: 'https://www.goapply.top', market: 'cn', brand: 'goapply', dev: true, open: false });
    const launcher = await waitFor(() => {
      const el = mounted.host.shadowRoot!.querySelector('.launcher');
      if (!el) throw new Error('not rendered yet');
      return el;
    });
    expect(launcher.textContent).toBe('一键填表');
    expect(launcher.getAttribute('aria-label')).toBe('打开 GoApply 一键填表');
    expect(api.calls).toEqual([]);
    mounted.unmount();
  });

  it('unmounting the panel removes the outline from the page', async () => {
    const { panel, doc } = renderCn();
    fireEvent.click(await panel.findByRole('button', { name: '全部填写' }));
    await panel.findByText('请核对后自行提交');
    await waitFor(() => expect(doc.querySelector(`[${SUBMIT_HINT_ATTR}]`)).toBeTruthy());
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    expect(doc.querySelector(`[${SUBMIT_HINT_ATTR}]`)).toBeNull();
  });
});

describe('RoboApply panel is unchanged', () => {
  it('one "Fill this form" button, no modes, the English closing line', async () => {
    restoreEnv();
    restoreEnv = () => {};
    setLocale('en');
    const doc = loadFixture('greenhouse', 'classic');
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<Panel adapter={greenhouseAdapter} doc={doc} url="https://boards.greenhouse.io/exampleco/jobs/1001" api={fakeApi().api} webOrigin="https://www.roboapply.io" market="intl" onCollapse={() => {}} />, { container: host });
    const panel = within(host);
    fireEvent.click(await panel.findByRole('button', { name: 'Fill this form' }));
    expect(await panel.findByText('Check the form, then submit it yourself.')).toBeTruthy();
    expect(panel.queryByRole('button', { name: /Fill blanks only|只填空白/ })).toBeNull();
    expect(doc.querySelector(`[${SUBMIT_HINT_ATTR}]`)).toBeNull();
    expect(screen.queryByText('请核对后自行提交')).toBeNull();
  });
});
