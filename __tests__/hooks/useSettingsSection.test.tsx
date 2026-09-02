// useSettingsSection — the open /settings section IS the URL hash.
//
// Three consumers read it (the app Sidebar's Settings group, the page's phone
// section row, the page body), and three kinds of URL change have to reach
// them: a fragment anchor click / location.hash write (hashchange), the back
// button (popstate), and a Next <Link> navigation, which rewrites the URL with
// pushState after the render that reacted to it and fires no event at all.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const pathnameRef = { current: '/settings' };
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import {
  SETTINGS_SECTIONS,
  sectionFromLocation,
  settingsSectionHref,
  syncSettingsSection,
  useSettingsSection,
} from '../../hooks/useSettingsSection';

afterEach(() => {
  pathnameRef.current = '/settings';
  window.history.replaceState(null, '', '/');
});

describe('sectionFromLocation', () => {
  it('reads the hash, falls back to the first section, and pins the invoice page to billing', () => {
    expect(sectionFromLocation('/settings', '#billing')).toBe('billing');
    expect(sectionFromLocation('/settings', '#danger')).toBe('danger');
    expect(sectionFromLocation('/settings', '')).toBe('search');
    expect(sectionFromLocation('/settings', '#nope')).toBe('search');
    expect(sectionFromLocation('/settings/billing/history', '')).toBe('billing');
    expect(sectionFromLocation('/settings/billing/history', '#danger')).toBe('billing');
  });

  it('lists seven sections, each with an absolute href usable from any route', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'search',
      'resume',
      'notif',
      'appearance',
      'billing',
      'account',
      'danger',
    ]);
    for (const s of SETTINGS_SECTIONS) {
      expect(settingsSectionHref(s.id)).toBe(`/settings#${s.id}`);
    }
    expect(SETTINGS_SECTIONS.filter((s) => s.danger).map((s) => s.id)).toEqual(['danger']);
  });
});

describe('useSettingsSection', () => {
  it('starts from the current hash and follows hashchange', async () => {
    window.history.replaceState(null, '', '/settings#account');
    const { result } = renderHook(() => useSettingsSection());
    expect(result.current).toBe('account');

    act(() => {
      window.location.hash = '#danger';
    });
    await waitFor(() => expect(result.current).toBe('danger'));
  });

  it('picks up a pushState the way Next navigates — no hashchange — once synced', () => {
    window.history.replaceState(null, '', '/settings');
    const { result } = renderHook(() => useSettingsSection());
    expect(result.current).toBe('search');

    act(() => {
      window.history.pushState(null, '', '/settings#billing');
      syncSettingsSection();
    });
    expect(result.current).toBe('billing');
  });

  it('follows the back button', async () => {
    window.history.replaceState(null, '', '/settings#search');
    window.history.pushState(null, '', '/settings#notif');
    const { result } = renderHook(() => useSettingsSection());
    expect(result.current).toBe('notif');

    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(result.current).toBe('search'));
  });

  it('is billing on the invoice page whatever the hash says', () => {
    pathnameRef.current = '/settings/billing/history';
    window.history.replaceState(null, '', '/settings/billing/history');
    const { result } = renderHook(() => useSettingsSection());
    expect(result.current).toBe('billing');
  });
});
