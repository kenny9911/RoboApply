// Toolbar popup: connect by code, Fill this form, Request this site.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Popup, type PopupDeps } from '../src/popup/Popup';
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

    fireEvent.change(screen.getByLabelText('Or enter the 8-character code from RoboApply'), { target: { value: 'ab12 cd34' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect with code' }));
    });
    expect(sent).toContainEqual({ type: 'redeem', code: 'AB12CD34' });
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

  it('on a known but unsupported form host: Request this site sends host and URL only', async () => {
    const { d, sent } = deps({ url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123?source=x', siteName: null });
    render(<Popup deps={d} />);
    expect(await screen.findByText('Forms on Workday can’t be filled yet.'.replace('’', "'"))).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request this site' }));
    });
    expect(sent).toContainEqual({ type: 'api', call: { op: 'siteRequest', body: { host: 'acme.wd5.myworkdayjobs.com', url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123' } } });
    expect(await screen.findByText('Request sent. Thanks.')).toBeTruthy();
    expect(d.inject).not.toHaveBeenCalled();
  });

  it('elsewhere: nothing on the page is read', async () => {
    const { d } = deps({ url: 'https://www.linkedin.com/jobs/view/1', siteName: null });
    render(<Popup deps={d} />);
    expect(await screen.findByText("Forms on this site can't be filled yet.")).toBeTruthy();
    expect(d.inject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy());
  });
});
