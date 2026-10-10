// WP-73 — GoApply WeChat notices on the web (Testing Library, jsdom; lib/api
// and the auth context are mocked, the `wx` global is a fake: no network).
//   - SubscribeOnTap is a pass-through outside WeChat, on RoboApply, for
//     visitors, with `notify.wechat` off, without a template id, and for
//     accounts not linked to the 公众号;
//   - inside WeChat it lays WeChat's `wx-open-subscribe` over the control,
//     records the answer, and always runs the control's own click;
//   - settings that keep WeChat off are pointed out with a link;
//   - the open tag never makes the control untappable (old WeChat,
//     WeixinOpenTagsError, a disabled control);
//   - iOS WeChat signs the entry URL (pushState navigations), Android the current one;
//   - WechatShareCard sets the share card from the caller's facts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, mockAuthState } from '../../../../__tests__/utils/mockAuth';
import enStaging from '../../../../i18n/staging/notifyCn.en.json';
import zhStaging from '../../../../i18n/staging/notifyCn.zh.json';

vi.mock('../../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));
const api = vi.hoisted(() => ({ subscribeWechatMessages: vi.fn(), getJsSdkSignature: vi.fn() }));
vi.mock('../../../../lib/api/notifyCn', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));

import { SETTINGS_HREF, SubscribeOnTap, WechatShareCard, isWechatBrowser } from '..';
import { parseSubscribeDetails, resetWechatSdkForTests, signedPageUrl, supportsOpenTags, urlToSign, wechatVersion, type WxSdk } from '../wechatSdk';

const WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50 NetType/WIFI';
const ANDROID_WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36 Chrome/116.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x28003133) NetType/WIFI';
const OLD_WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/7.0.11(0x17000b21) NetType/WIFI';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const TPL = 'Tpl_Deadline_01';

function signature(over: Record<string, unknown> = {}) {
  return { appId: 'wx_mp_app', timestamp: 1, nonceStr: 'n', signature: 's', templates: { deadline_reminder: TPL }, canDeliver: true, ...over };
}

type FakeWx = WxSdk & { config: ReturnType<typeof vi.fn>; updateAppMessageShareData: ReturnType<typeof vi.fn>; updateTimelineShareData: ReturnType<typeof vi.fn> };

function fakeWx(): FakeWx {
  let readyCb: (() => void) | null = null;
  const wx = {
    config: vi.fn(() => queueMicrotask(() => readyCb?.())),
    ready: (cb: () => void) => {
      readyCb = cb;
    },
    error: () => undefined,
    updateAppMessageShareData: vi.fn(),
    updateTimelineShareData: vi.fn(),
  };
  return wx;
}

let ua = WECHAT_UA;
let wx: ReturnType<typeof fakeWx>;

beforeEach(() => {
  resetWechatSdkForTests();
  ua = WECHAT_UA;
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => ua);
  wx = fakeWx();
  (window as unknown as { wx?: WxSdk }).wx = wx;
  mockAuthState.value = buildAuthValue();
  api.getJsSdkSignature.mockReset().mockResolvedValue(signature());
  api.subscribeWechatMessages.mockReset().mockResolvedValue({ recorded: ['deadline_reminder'], canDeliver: true, wechatChannelOn: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { wx?: WxSdk }).wx;
});

const onFlags = { 'notify.wechat': true };

function tapUi(onClick: () => void, disabled = false): ReactElement {
  return (
    <SubscribeOnTap template="deadline_reminder">
      <button type="button" onClick={onClick} disabled={disabled}>
        截止提醒
      </button>
    </SubscribeOnTap>
  );
}

function renderTap(opts: { brand?: 'goapply' | 'roboapply'; flags?: Record<string, boolean>; zh?: boolean; disabled?: boolean } = {}) {
  const onClick = vi.fn();
  const r = renderWithBrand(tapUi(onClick, opts.disabled), { brand: opts.brand ?? 'goapply', flags: opts.flags ?? onFlags });
  return { ...r, onClick };
}

const openTag = (container: HTMLElement) => container.querySelector('wx-open-subscribe') as HTMLElement | null;

function successEvent(details: Record<string, string>) {
  return new CustomEvent('success', { detail: { subscribeDetails: JSON.stringify(details) } });
}

describe('SubscribeOnTap: pass-through cases', () => {
  it.each([
    ['outside WeChat', () => (ua = SAFARI_UA), {}],
    ['on RoboApply', () => undefined, { brand: 'roboapply' as const }],
    ['with notify.wechat off', () => undefined, { flags: {} }],
    ['for a visitor', () => (mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null })), {}],
  ])('%s: children unchanged, no SDK, no API call', async (_label, setup, opts) => {
    setup();
    const { container, onClick } = renderTap(opts);
    await act(async () => undefined);
    expect(container.querySelector('[data-wechat-subscribe]')).toBeNull();
    expect(openTag(container)).toBeNull();
    expect(api.getJsSdkSignature).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '截止提醒' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('no open tag when the account is not linked or the template has no id', async () => {
    api.getJsSdkSignature.mockResolvedValueOnce(signature({ canDeliver: false }));
    const a = renderTap();
    await waitFor(() => expect(api.getJsSdkSignature).toHaveBeenCalled());
    await act(async () => undefined);
    expect(openTag(a.container)).toBeNull();
    a.unmount();
    resetWechatSdkForTests();
    api.getJsSdkSignature.mockResolvedValueOnce(signature({ templates: {} }));
    const b = renderTap();
    await waitFor(() => expect(api.getJsSdkSignature).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(openTag(b.container)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '截止提醒' }));
    expect(b.onClick).toHaveBeenCalledOnce();
  });

  it('a failed signature leaves the control as it is', async () => {
    api.getJsSdkSignature.mockRejectedValueOnce(new Error('503'));
    const { container, onClick } = renderTap();
    await waitFor(() => expect(api.getJsSdkSignature).toHaveBeenCalled());
    await act(async () => undefined);
    expect(openTag(container)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '截止提醒' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('SubscribeOnTap inside WeChat', () => {
  it('configures the JS-SDK for this page with the open tag and lays wx-open-subscribe over the control', async () => {
    const { container } = renderTap();
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    expect(api.getJsSdkSignature).toHaveBeenCalledWith({ url: signedPageUrl(window.location.href) });
    expect(wx.config).toHaveBeenCalledWith(expect.objectContaining({ appId: 'wx_mp_app', debug: false, openTagList: ['wx-open-subscribe'] }));
    const tag = openTag(container)!;
    expect(tag.getAttribute('template')).toBe(TPL);
    expect(tag.innerHTML).toContain('text/wxtag-template');
    expect(container.querySelector('[data-wechat-subscribe="on"]')).not.toBeNull();
  });

  it('records an accepted prompt and then runs the control’s own click', async () => {
    const { container, onClick } = renderTap();
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    act(() => {
      openTag(container)!.dispatchEvent(successEvent({ [TPL]: JSON.stringify({ status: 'accept' }) }));
    });
    expect(onClick).toHaveBeenCalledOnce();
    expect(api.subscribeWechatMessages).toHaveBeenCalledWith({
      templateKeys: ['deadline_reminder'],
      scene: 'campus_deadline',
      results: { deadline_reminder: 'accept' },
    });
    await act(async () => undefined);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a refused prompt or a WeChat error still runs the reminder', async () => {
    const { container, onClick } = renderTap();
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    act(() => {
      openTag(container)!.dispatchEvent(new CustomEvent('error', { detail: { errCode: 1 } }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(api.subscribeWechatMessages).not.toHaveBeenCalled();
    act(() => {
      openTag(container)!.dispatchEvent(successEvent({ [TPL]: JSON.stringify({ status: 'reject' }) }));
    });
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(api.subscribeWechatMessages).toHaveBeenLastCalledWith(expect.objectContaining({ results: { deadline_reminder: 'reject' } }));
  });

  it('points to notification settings when WeChat is off there', async () => {
    api.subscribeWechatMessages.mockResolvedValueOnce({ recorded: ['deadline_reminder'], canDeliver: true, wechatChannelOn: false });
    const { container } = renderTap();
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    act(() => {
      openTag(container)!.dispatchEvent(successEvent({ [TPL]: JSON.stringify({ status: 'accept' }) }));
    });
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(enStaging.notifyCn.subscribe.channelOff);
    expect(screen.getByRole('link', { name: enStaging.notifyCn.subscribe.settingsLink })).toHaveAttribute('href', SETTINGS_HREF);
  });
});

describe('SubscribeOnTap never blocks the control', () => {
  it('WeChat older than 7.0.12 (no open tags): no tag, the button works', async () => {
    ua = OLD_WECHAT_UA;
    const { container, onClick } = renderTap();
    await waitFor(() => expect(wx.config).toHaveBeenCalled());
    await act(async () => undefined);
    expect(openTag(container)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '截止提醒' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('WeixinOpenTagsError takes the tag away and the button click reaches onClick', async () => {
    const { container, onClick } = renderTap();
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    act(() => {
      document.dispatchEvent(new CustomEvent('WeixinOpenTagsError', { detail: { errMsg: 'tags not supported' } }));
    });
    await waitFor(() => expect(openTag(container)).toBeNull());
    expect(container.querySelector('[data-wechat-subscribe="off"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '截止提醒' }));
    expect(onClick).toHaveBeenCalledOnce();
    // A control mounted later on the same page gets no tag either.
    const later = renderTap();
    await act(async () => undefined);
    expect(openTag(later.container)).toBeNull();
  });

  it('no tag over a disabled control; it comes back when the control is enabled again', async () => {
    const { container } = renderTap({ disabled: true });
    await waitFor(() => expect(wx.config).toHaveBeenCalled());
    await act(async () => undefined);
    expect(openTag(container)).toBeNull();
    const button = screen.getByRole('button', { name: '截止提醒' }) as HTMLButtonElement;
    // The wrapped control switches itself on and off (e.g. while a reminder is saved).
    act(() => {
      button.disabled = false;
      button.removeAttribute('disabled');
    });
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    act(() => button.setAttribute('aria-disabled', 'true'));
    await waitFor(() => expect(openTag(container)).toBeNull());
    act(() => button.removeAttribute('aria-disabled'));
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    act(() => button.setAttribute('disabled', ''));
    await waitFor(() => expect(openTag(container)).toBeNull());
  });
});

describe('JS-SDK signature URL', () => {
  const start = window.location.href;
  afterEach(() => window.history.replaceState(null, '', start));

  it('iOS WeChat signs the URL the page was entered at, even after a client navigation', async () => {
    window.history.pushState(null, '', '/campus?year=2027#list');
    const { container } = renderTap();
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    expect(api.getJsSdkSignature).toHaveBeenCalledWith({ url: signedPageUrl(start) });
    expect(signedPageUrl(start)).not.toBe(signedPageUrl(window.location.href));
  });

  it('Android WeChat signs the current URL', async () => {
    ua = ANDROID_WECHAT_UA;
    window.history.pushState(null, '', '/campus?year=2027#list');
    const { container } = renderTap();
    await waitFor(() => expect(openTag(container)).not.toBeNull());
    expect(api.getJsSdkSignature).toHaveBeenCalledWith({ url: `${window.location.origin}/campus?year=2027` });
  });

  it('prefers the document’s navigation entry on iOS', () => {
    const entry = `${window.location.origin}/jobs/job_1?from=share`;
    const perf = performance as Performance & { getEntriesByType?: Performance['getEntriesByType'] };
    const had = Object.prototype.hasOwnProperty.call(perf, 'getEntriesByType');
    const original = perf.getEntriesByType;
    Object.defineProperty(perf, 'getEntriesByType', {
      configurable: true,
      value: (type: string) => (type === 'navigation' ? [{ name: `${entry}#top` }] : []),
    });
    try {
      expect(urlToSign(`${window.location.origin}/campus`, WECHAT_UA)).toBe(entry);
      expect(urlToSign(`${window.location.origin}/campus#x`, ANDROID_WECHAT_UA)).toBe(`${window.location.origin}/campus`);
    } finally {
      if (had) Object.defineProperty(perf, 'getEntriesByType', { configurable: true, value: original });
      else delete (perf as { getEntriesByType?: unknown }).getEntriesByType;
    }
  });
});

describe('WechatShareCard', () => {
  it('sets the chat and Moments card from the caller’s facts, with the brand image', async () => {
    renderWithBrand(<WechatShareCard title="数据分析师 · 某公司" description="上海 · 薪资 15-25K" path="/jobs/job_1" />, { brand: 'goapply', flags: onFlags });
    await waitFor(() => expect(wx.updateAppMessageShareData).toHaveBeenCalled());
    const origin = window.location.origin;
    expect(wx.updateAppMessageShareData).toHaveBeenCalledWith({
      title: '数据分析师 · 某公司',
      desc: '上海 · 薪资 15-25K',
      link: `${origin}/jobs/job_1`,
      imgUrl: `${origin}/brands/goapply/apple-touch.png`,
    });
    expect(wx.updateTimelineShareData).toHaveBeenCalledWith({ title: '数据分析师 · 某公司', link: `${origin}/jobs/job_1`, imgUrl: `${origin}/brands/goapply/apple-touch.png` });
  });

  it('without a description says only where the page is; ignores off-site paths', async () => {
    renderWithBrand(<WechatShareCard title="数据分析师" path="//evil.example/x" />, { brand: 'goapply', flags: onFlags });
    await waitFor(() => expect(wx.updateAppMessageShareData).toHaveBeenCalled());
    const arg = wx.updateAppMessageShareData.mock.calls[0]![0] as { desc: string; link: string };
    // The test intl wrapper fills %BRAND% itself; the bundle text is what matters.
    expect(arg.desc).toMatch(new RegExp(`^${enStaging.notifyCn.share.defaultDescription.replace('%BRAND%', '\\w+')}$`));
    expect(arg.link).toBe(signedPageUrl(window.location.href));
  });

  it('does nothing outside WeChat', async () => {
    ua = SAFARI_UA;
    const { container } = renderWithBrand(<WechatShareCard title="数据分析师" />, { brand: 'goapply', flags: onFlags });
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
    expect(api.getJsSdkSignature).not.toHaveBeenCalled();
    expect(wx.updateAppMessageShareData).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('reads the WeChat version; open tags from 7.0.12', () => {
    expect(wechatVersion(ANDROID_WECHAT_UA)).toEqual([8, 0, 49]);
    expect(wechatVersion(SAFARI_UA)).toBeNull();
    expect(supportsOpenTags(OLD_WECHAT_UA)).toBe(false);
    expect(supportsOpenTags(WECHAT_UA.replace('8.0.50', '7.0.12'))).toBe(true);
    expect(supportsOpenTags(WECHAT_UA.replace('8.0.50', '7.1'))).toBe(true);
    expect(supportsOpenTags(WECHAT_UA.replace('8.0.50', '6.9.99'))).toBe(false);
    expect(supportsOpenTags(SAFARI_UA)).toBe(false);
  });

  it('detects the WeChat browser', () => {
    expect(isWechatBrowser(WECHAT_UA)).toBe(true);
    expect(isWechatBrowser(SAFARI_UA)).toBe(false);
    expect(isWechatBrowser(null)).toBe(false);
  });

  it('parses subscribeDetails by template id (string or object statuses), ignoring unknown ids and values', () => {
    const templates = { deadline_reminder: TPL, payment_success: 'Tpl_Pay' };
    expect(parseSubscribeDetails(JSON.stringify({ [TPL]: '{"status":"accept"}', Tpl_Pay: { status: 'reject' }, other: '{"status":"accept"}' }), templates)).toEqual({
      deadline_reminder: 'accept',
      payment_success: 'reject',
    });
    expect(parseSubscribeDetails({ [TPL]: '{"status":"maybe"}' }, templates)).toEqual({});
    expect(parseSubscribeDetails('not json', templates)).toEqual({});
  });

  it('zh copy exists for every English key', () => {
    const keys = (o: Record<string, unknown>, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(zhStaging).sort()).toEqual(keys(enStaging).sort());
  });
});
