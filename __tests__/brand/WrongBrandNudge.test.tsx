// WP-12 / TW-01: the wrong-market nudge banner. Shows for CN on RoboApply and
// for TW/HK/zh-TW on GoApply, is dismissible, remembers the dismissal (in
// RAUserUiState for signed-in users, localStorage for everyone), never
// redirects, and renders nothing until it knows the dismissal state.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
  getUiState: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('../../lib/api/uiState', () => ({ getUiState: ui.getUiState, dismiss: ui.dismiss }));

import { WrongBrandNudge } from '../../components/features/brand';
import { nudgeDismissKey, nudgeStorageKey } from '../../components/features/brand/nudge';
import { renderBranded } from './helpers';

function unauthenticated() {
  ui.getUiState.mockRejectedValue(Object.assign(new Error('HTTP 401'), { status: 401 }));
}
function signedIn(dismissals: Record<string, { count: number; at: string }> = {}) {
  ui.getUiState.mockResolvedValue({
    state: { tours: {}, dismissals, popupLastShownAt: null, announcementsSeen: [], values: {} },
    lastFeedVisitAt: null,
    updatedAt: null,
  });
}

const originalLocation = window.location.href;

beforeEach(() => {
  ui.getUiState.mockReset();
  ui.dismiss.mockReset().mockResolvedValue({});
  window.localStorage.clear();
  document.cookie = 'robo_locale=; max-age=0; path=/';
  document.cookie = 'ra_clamped_from=; max-age=0; path=/';
});
afterEach(() => {
  expect(window.location.href).toBe(originalLocation); // never redirects
});

describe('WrongBrandNudge', () => {
  it('RoboApply + country CN: offers GoApply with a link, after the dismissal state is known', async () => {
    unauthenticated();
    const { container } = renderBranded(<WrongBrandNudge country="CN" locale="en" />, { brand: 'roboapply' });
    // Nothing on first paint: the dismissal state is not known yet.
    expect(container).toBeEmptyDOMElement();
    const banner = await screen.findByTestId('wrong-brand-nudge');
    expect(banner).toHaveAttribute('data-reason', 'country_cn');
    expect(screen.getByText('In mainland China?')).toBeInTheDocument();
    expect(screen.getByText('GoApply is our service for job seekers in mainland China.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Go to GoApply' });
    expect(link).toHaveAttribute('href', 'https://www.goapply.top/');
    expect(link).toHaveAttribute('hreflang', 'zh');
    expect(screen.getByRole('complementary', { name: 'Suggested site' })).toBe(banner);
  });

  it('RoboApply + any other country renders nothing and never calls the API', async () => {
    unauthenticated();
    const { container } = renderBranded(<WrongBrandNudge country="TW" locale="zh-TW" />, { brand: 'roboapply', locale: 'zh-TW' });
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(ui.getUiState).not.toHaveBeenCalled();
  });

  it.each(['TW', 'HK'])('GoApply + country %s: offers RoboApply in Traditional Chinese', async (country) => {
    unauthenticated();
    renderBranded(<WrongBrandNudge country={country} locale="zh" />, { brand: 'goapply' });
    const banner = await screen.findByTestId('wrong-brand-nudge');
    expect(banner).toHaveAttribute('data-reason', 'region_traditional');
    const link = screen.getByRole('link', { name: /RoboApply/ });
    expect(link).toHaveAttribute('href', 'https://www.roboapply.io/zh-TW');
    expect(link).toHaveAttribute('hreflang', 'zh-TW');
  });

  it('GoApply + a zh-TW cookie (the page itself was clamped to zh): offers RoboApply', async () => {
    unauthenticated();
    document.cookie = 'robo_locale=zh-TW; path=/';
    renderBranded(<WrongBrandNudge country="CN" locale="zh" />, { brand: 'goapply' });
    expect(await screen.findByTestId('wrong-brand-nudge')).toHaveAttribute('data-reason', 'locale_zh_tw');
  });

  it('GoApply after the /zh-TW → /zh clamp (ra_clamped_from cookie): offers RoboApply in Traditional Chinese', async () => {
    unauthenticated();
    // Mainland IP, Simplified page, English browser: only the clamp marker says zh-TW.
    document.cookie = 'ra_clamped_from=zh-TW; path=/';
    renderBranded(<WrongBrandNudge country="CN" locale="zh" />, { brand: 'goapply' });
    const banner = await screen.findByTestId('wrong-brand-nudge');
    expect(banner).toHaveAttribute('data-reason', 'locale_zh_tw');
    expect(screen.getByRole('link', { name: /RoboApply/ })).toHaveAttribute('href', 'https://www.roboapply.io/zh-TW');
  });

  it('GoApply after the clamp (from_locale query): offers RoboApply in Traditional Chinese', async () => {
    unauthenticated();
    window.history.replaceState(null, '', '/?from_locale=zh-TW');
    try {
      renderBranded(<WrongBrandNudge country={null} locale="zh" />, { brand: 'goapply' });
      expect(await screen.findByTestId('wrong-brand-nudge')).toHaveAttribute('data-reason', 'locale_zh_tw');
    } finally {
      window.history.replaceState(null, '', originalLocation);
    }
  });

  it('RoboApply + country CN + a 繁體中文 page renders nothing (GoApply has no zh-TW)', async () => {
    unauthenticated();
    const { container } = renderBranded(<WrongBrandNudge country="CN" locale="zh-TW" />, { brand: 'roboapply', locale: 'zh-TW' });
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(ui.getUiState).not.toHaveBeenCalled();
  });

  it('GoApply + a mainland visitor renders nothing', async () => {
    unauthenticated();
    const { container } = renderBranded(<WrongBrandNudge country="CN" locale="zh" />, { brand: 'goapply' });
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it('dismissing hides it, remembers it locally, and (signed out) does not call the API', async () => {
    unauthenticated();
    const first = renderBranded(<WrongBrandNudge country="CN" locale="en" />, { brand: 'roboapply' });
    fireEvent.click(await screen.findByRole('button', { name: 'Stay here' }));
    expect(screen.queryByTestId('wrong-brand-nudge')).toBeNull();
    expect(window.localStorage.getItem(nudgeStorageKey('roboapply'))).not.toBeNull();
    expect(ui.dismiss).not.toHaveBeenCalled();
    first.unmount();

    // Next page view: stays dismissed, without asking the API.
    ui.getUiState.mockClear();
    const { container } = renderBranded(<WrongBrandNudge country="CN" locale="en" />, { brand: 'roboapply' });
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(ui.getUiState).not.toHaveBeenCalled();
  });

  it('a signed-in dismissal is written to RAUserUiState', async () => {
    signedIn();
    renderBranded(<WrongBrandNudge country="CN" locale="en" />, { brand: 'roboapply' });
    fireEvent.click(await screen.findByRole('button', { name: 'Stay here' }));
    await waitFor(() => expect(ui.dismiss).toHaveBeenCalledWith([nudgeDismissKey('roboapply')]));
  });

  it('a dismissal stored in RAUserUiState (another device) keeps it hidden and is mirrored locally', async () => {
    signedIn({ [nudgeDismissKey('goapply')]: { count: 1, at: '2026-10-01T00:00:00.000Z' } });
    const { container } = renderBranded(<WrongBrandNudge country="HK" locale="zh" />, { brand: 'goapply' });
    await waitFor(() => expect(ui.getUiState).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(window.localStorage.getItem(nudgeStorageKey('goapply'))).not.toBeNull();
  });

  it("one brand's dismissal does not hide the other brand's nudge", async () => {
    window.localStorage.setItem(nudgeStorageKey('goapply'), '2026-10-01');
    unauthenticated();
    renderBranded(<WrongBrandNudge country="CN" locale="en" />, { brand: 'roboapply' });
    expect(await screen.findByTestId('wrong-brand-nudge')).toBeInTheDocument();
  });

  it('works when storage is blocked (private mode)', async () => {
    unauthenticated();
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const spySet = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderBranded(<WrongBrandNudge country="CN" locale="en" />, { brand: 'roboapply' });
      fireEvent.click(await screen.findByRole('button', { name: 'Stay here' }));
      expect(screen.queryByTestId('wrong-brand-nudge')).toBeNull();
    } finally {
      spy.mockRestore();
      spySet.mockRestore();
    }
  });

  it('its buttons are 44 px touch targets (class + stylesheet contract)', async () => {
    unauthenticated();
    renderBranded(<WrongBrandNudge country="CN" locale="en" />, { brand: 'roboapply' });
    const button = await screen.findByRole('button', { name: 'Stay here' });
    expect(button.className).toMatch(/nudgeDismiss/);
    expect(screen.getByRole('link', { name: 'Go to GoApply' }).className).toMatch(/nudgeCta/);

    // jsdom computes no CSS, so read the rules: the shared button rule sets
    // min-height to --control-lg, and --control-lg is 44px.
    const css = readFileSync(join(process.cwd(), 'components/features/brand/brand.module.css'), 'utf8');
    const rule = css.match(/\.nudgeCta,\s*\.nudgeDismiss\s*\{([^}]*)\}/);
    expect(rule, '.nudgeCta, .nudgeDismiss rule').not.toBeNull();
    expect(rule![1]).toMatch(/min-height:\s*var\(--control-lg\)\s*;/);
    // No later rule for either class may lower it.
    const later = css.slice(css.indexOf(rule![0]) + rule![0].length);
    expect(later).not.toMatch(/\.nudge(?:Cta|Dismiss)[^{]*\{[^}]*(?:min-height|height)\s*:/);
    const globals = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(globals).toMatch(/--control-lg:\s*44px\s*;/);
  });

  it('never takes the page down: without the intl provider it renders nothing', async () => {
    unauthenticated();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = render(<WrongBrandNudge country="CN" locale="en" />);
      await waitFor(() => expect(ui.getUiState).toHaveBeenCalled());
      await act(async () => {});
      expect(container).toBeEmptyDOMElement();
    } finally {
      errors.mockRestore();
    }
  });
});
