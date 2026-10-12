// "请核对后自行提交": the panel outlines the portal's OWN submit control after a
// fill. It finds, outlines and scrolls; it never presses or submits (D1).

import { describe, expect, it, vi } from 'vitest';

import { dayeeAdapter } from '../../src/adapters/cn/dayee';
import { feishuAdapter } from '../../src/adapters/cn/feishu';
import { genericCnAdapter } from '../../src/adapters/cn/generic';
import { mokaAdapter } from '../../src/adapters/cn/moka';
import { beisenAdapter } from '../../src/adapters/cn/beisen';
import { findSubmitControl, outlineSubmitControl, revealSubmitControl, SUBMIT_HINT_ATTR } from '../../src/content/panel/submitHint';
import { loadCnFixture } from './helpers';

function nameOf(el: HTMLElement | null): string {
  if (!el) return '';
  return el instanceof HTMLInputElement ? el.value : (el.textContent ?? '').trim();
}

describe('findSubmitControl', () => {
  it('picks the portal button that sends, not 保存草稿 / 上传 / 添加', () => {
    expect(nameOf(findSubmitControl(loadCnFixture('moka', 'campus'), mokaAdapter))).toBe('提交申请');
    expect(nameOf(findSubmitControl(loadCnFixture('beisen', 'intern'), beisenAdapter))).toBe('确认提交');
    expect(nameOf(findSubmitControl(loadCnFixture('beisen', 'family'), beisenAdapter))).toBe('提交');
    expect(nameOf(findSubmitControl(loadCnFixture('feishu', 'campus'), feishuAdapter))).toBe('投递');
    expect(nameOf(findSubmitControl(loadCnFixture('dayee', 'campus'), dayeeAdapter))).toBe('提交');
    expect(nameOf(findSubmitControl(loadCnFixture('generic', 'div-labels'), genericCnAdapter))).toBe('确认投递');
  });

  it('a step that has only 下一步 has no submit control yet', () => {
    expect(findSubmitControl(loadCnFixture('moka', 'social'), mokaAdapter)).toBeNull();
    expect(findSubmitControl(loadCnFixture('dayee', 'social'), dayeeAdapter)).toBeNull();
  });

  it('ignores hidden controls', () => {
    const doc = loadCnFixture('moka', 'campus');
    doc.querySelector('.apply-submit')!.setAttribute('hidden', '');
    expect(findSubmitControl(doc, mokaAdapter)).toBeNull();
  });
});

describe('outline and reveal', () => {
  it('outlines with an inline style, restores the page as it was, and never presses', () => {
    const doc = loadCnFixture('moka', 'campus');
    const el = findSubmitControl(doc, mokaAdapter)!;
    el.style.outline = '1px dotted red';
    const pressed = vi.fn();
    const submitted = vi.fn();
    el.addEventListener('click', pressed);
    doc.addEventListener('submit', submitted, true);
    const focus = vi.spyOn(el, 'focus');
    const restore = outlineSubmitControl(el);
    expect(el.getAttribute(SUBMIT_HINT_ATTR)).toBe('true');
    expect(el.style.getPropertyValue('outline')).toContain('Highlight');
    expect(el.style.getPropertyPriority('outline')).toBe('important');
    const scroll = vi.fn();
    (el as HTMLElement & { scrollIntoView: unknown }).scrollIntoView = scroll;
    revealSubmitControl(el);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    restore();
    expect(el.hasAttribute(SUBMIT_HINT_ATTR)).toBe(false);
    expect(el.style.outline).toBe('1px dotted red');
    expect(pressed).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
