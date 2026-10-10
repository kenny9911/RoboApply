// Toolbar popup: connect by code, Fill this form, Request this site.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { setBuildEnvForTests } from '../src/env';
import { Popup, mayInjectForFallback, type PopupDeps } from '../src/popup/Popup';
import type { InternalMessage, StatusResponse } from '../src/shared/messages';

function status(over: Partial<StatusResponse> = {}): StatusResponse {
  return { connected: true, needsReconnect: false, brand: 'roboapply', version: '0.1.0', webOrigin: 'https://www.roboapply.io', ...over };
}

function deps(over: Partial<PopupDeps> & { st?: StatusResponse; url?: string; siteName?: string | null } = {}) {
  const sent: InternalMessage[] = [];
  const tabMessages: unknown[] = [];
  const d: PopupDeps = {
    send: vi.fn(async (msg: InternalMessage) => {
      sent.push(msg);
      if (msg.type === 'status' || msg.type === 'disconnect') return over.st ?? status();
      if (msg.type === 'redeem') return { ok: true, data: status() };
      return { ok: true, data: null };
    }),
    activeTab: async () => ({ id: 7, url: over.url ?? 'https://boards.greenhouse.io/exampleco/jobs/1001' }),
    tabMessage: vi.fn(async (_id: number, msg: unknown) => {
      tabMessages.push(msg);
      return (msg as { type: string }).type === 'content.ping' ? (over.siteName === undefined ? { siteName: 'Greenhouse' } : over.siteName === null ? null : { siteName: over.siteName }) : { ok: true };
    }),
    inject: vi.fn(async () => true),
    openTab: vi.fn(),
    close: vi.fn(),
    adapterSet: 'intl',
    ...over,
  };
  return { d, sent, tabMessages };
}

describe('Popup', () => {
  it('not connected: open the site, or connect with a code', async () => {
    const { d, sent } = deps({ st: status({ connected: false }) });
    render(<Popup deps={d} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open RoboApply to connect' }));
    expect(d.openTab).toHaveBeenCalledWith('https://www.roboapply.io/extension');

    fireEvent.change(screen.getByLabelText('Or enter the 8-character code from RoboApply'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with code' }));
    expect(await screen.findByText(/That code doesn't work/)).toBeTruthy();
    expect(sent.some((m) => m.type === 'redeem')).toBe(false);

    // Codes never contain 0, O, 1 or I (the server's alphabet): refused before any request.
    fireEvent.change(screen.getByLabelText('Or enter the 8-character code from RoboApply'), { target: { value: 'ab10 cd34' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect with code' }));
    expect(sent.some((m) => m.type === 'redeem')).toBe(false);

    fireEvent.change(screen.getByLabelText('Or enter the 8-character code from RoboApply'), { target: { value: 'ab23 cd45' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect with code' }));
    });
    expect(sent).toContainEqual({ type: 'redeem', code: 'AB23CD45' });
  });

  it('revoked device: asks to reconnect', async () => {
    const { d } = deps({ st: status({ connected: false, needsReconnect: true }) });
    render(<Popup deps={d} />);
    expect(await screen.findByRole('button', { name: 'Reconnect RoboApply' })).toBeTruthy();
  });

  it('on a supported form: "Fill this form" opens the panel', async () => {
    const { d, tabMessages } = deps();
    render(<Popup deps={d} />);
    const button = await screen.findByRole('button', { name: 'Fill this form' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(tabMessages).toContainEqual({ type: 'panel.open' });
    expect(d.close).toHaveBeenCalled();
    expect(screen.getByText('Check the form, then submit it yourself.')).toBeTruthy();
  });

  // Wave 5 gate (WP-70 R1): Workday ships in WP-70, so the unsupported-host
  // case moves to an unknown careers host; Workday itself is covered below.
  it('on an unsupported form host: Request this site sends host and URL only', async () => {
    const { d, sent } = deps({ url: 'https://careers.example.test/apply?source=x', siteName: null });
    render(<Popup deps={d} />);
    expect(await screen.findByText("Forms on this site can't be filled yet.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request this site' }));
    });
    expect(sent).toContainEqual({ type: 'api', call: { op: 'siteRequest', body: { host: 'careers.example.test', url: 'https://careers.example.test/apply' } } });
    expect(await screen.findByText('Request sent. Thanks.')).toBeTruthy();
    expect(d.inject).not.toHaveBeenCalled();
  });

  it('on a supported form site with no form open (Workday job page): says to open the form, never Request this site (WP-70 R7)', async () => {
    const { d } = deps({ url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123', siteName: null });
    render(<Popup deps={d} />);
    expect(await screen.findByText('On Workday, open the application form, then choose Fill this form.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request this site' })).toBeNull();
    expect(d.inject).not.toHaveBeenCalled();
  });

  // WP-93 (GoApply popup): the registered content script runs only on the four
  // portals. Elsewhere the toolbar click (activeTab) injects it once and asks
  // again, so the label-based fallback adapter can find a form on a company's
  // own career site.
  it('GoApply, a page with no content script: inject under activeTab, ping again, offer the fill', async () => {
    const restore = setBuildEnvForTests({ brand: 'goapply' });
    try {
      let injected = false;
      const pings: boolean[] = [];
      const { d, tabMessages } = deps({
        adapterSet: 'cn',
        market: 'cn',
        st: status({ brand: 'goapply', webOrigin: 'https://www.goapply.top' }),
        url: 'https://careers.example-games.cn/apply/1?from=home',
        tabMessage: vi.fn(async (_id: number, msg: unknown) => {
          const type = (msg as { type: string }).type;
          if (type === 'content.ping') {
            pings.push(injected);
            // The fallback adapter names the form by the page's own host.
            return injected ? { siteName: 'careers.example-games.cn' } : null;
          }
          return { ok: true };
        }),
        inject: vi.fn(async () => {
          injected = true;
          return true;
        }),
      });
      render(<Popup deps={d} />);
      const button = await screen.findByRole('button', { name: 'Fill this form' });
      expect(d.inject).toHaveBeenCalledTimes(1);
      expect(d.inject).toHaveBeenCalledWith(7);
      expect(pings).toEqual([false, true]);
      expect(screen.getByText('Form on careers.example-games.cn')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Request this site' })).toBeNull();
      await act(async () => {
        fireEvent.click(button);
      });
      expect(d.tabMessage).toHaveBeenLastCalledWith(7, { type: 'panel.open' });
      void tabMessages;
    } finally {
      restore();
    }
  });

  it('GoApply: no form found after the injection → Request this site, injected once', async () => {
    const restore = setBuildEnvForTests({ brand: 'goapply' });
    try {
      let injected = false;
      const { d } = deps({
        adapterSet: 'cn',
        url: 'https://www.example-games.cn/about',
        tabMessage: vi.fn(async () => (injected ? { siteName: null } : null)),
        inject: vi.fn(async () => {
          injected = true;
          return true;
        }),
      });
      render(<Popup deps={d} />);
      expect(await screen.findByRole('button', { name: 'Request this site' })).toBeTruthy();
      expect(d.inject).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Fill this form' })).toBeNull();
    } finally {
      restore();
    }
  });

  it('GoApply: never injects on a job board, a browser page, or when the script already answered; RoboApply never does', async () => {
    expect(mayInjectForFallback(new URL('https://careers.example-games.cn/apply/1'), 'cn')).toBe(true);
    expect(mayInjectForFallback(new URL('https://www.zhipin.com/job_detail/1.html'), 'cn')).toBe(false);
    expect(mayInjectForFallback(new URL('https://www.linkedin.cn/jobs/view/1'), 'cn')).toBe(false);
    expect(mayInjectForFallback(new URL('chrome://extensions'), 'cn')).toBe(false);
    expect(mayInjectForFallback(new URL('https://careers.example.test/apply'), 'intl')).toBe(false);

    const restore = setBuildEnvForTests({ brand: 'goapply' });
    try {
      const portal = deps({ adapterSet: 'cn', url: 'https://app.mokahr.com/campus-recruitment/x/1', siteName: 'Moka' });
      render(<Popup deps={portal.d} />);
      await screen.findByRole('button', { name: 'Fill this form' });
      expect(portal.d.inject).not.toHaveBeenCalled();
      cleanup();

      const board = deps({ adapterSet: 'cn', url: 'https://www.zhipin.com/job_detail/1.html', siteName: null });
      render(<Popup deps={board.d} />);
      await screen.findByRole('button', { name: 'Request this site' });
      expect(board.d.inject).not.toHaveBeenCalled();
      cleanup();

      // The injection is refused (a browser page, or the store): one ping, no retry.
      const refused = deps({ adapterSet: 'cn', url: 'https://careers.example-games.cn/apply/1', siteName: null, inject: vi.fn(async () => false) });
      render(<Popup deps={refused.d} />);
      await screen.findByRole('button', { name: 'Request this site' });
      expect(refused.tabMessages).toEqual([{ type: 'content.ping' }]);
    } finally {
      restore();
    }
  });

  it('elsewhere: nothing on the page is read', async () => {
    const { d } = deps({ url: 'https://www.linkedin.com/jobs/view/1', siteName: null });
    render(<Popup deps={d} />);
    expect(await screen.findByText("Forms on this site can't be filled yet.")).toBeTruthy();
    expect(d.inject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy());
  });
});
