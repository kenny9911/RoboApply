// WP-12: both language switchers list the brand's locales (nine on
// RoboApply, 简体中文 + English on GoApply), and the in-app switcher persists
// through lib/api/brand.ts instead of a raw /api/v1 call.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
}));

import { LanguageMenu } from '../../components/landing/LanguageMenu';
import { LanguageSwitcher } from '../../components/v3/shell/LanguageSwitcher';
import { getPublicBrand, setLocalePreference } from '../../lib/api/brand';
import { renderBranded } from './helpers';

const fetchMock = vi.fn();

beforeEach(() => {
  nav.refresh.mockReset();
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { locale: 'ja' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  document.cookie = 'robo_locale=; max-age=0; path=/';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit };
}

describe('LanguageSwitcher (in-app)', () => {
  it('RoboApply lists all nine languages', () => {
    renderBranded(<LanguageSwitcher variant="full" />, { brand: 'roboapply' });
    const radios = within(screen.getByRole('radiogroup')).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'English',
      '简体中文',
      '繁體中文',
      '日本語',
      '한국어',
      'Español',
      'Français',
      'Português',
      'Deutsch',
    ]);
  });

  it('GoApply lists only 简体中文 and English, in that order', () => {
    renderBranded(<LanguageSwitcher variant="full" />, { brand: 'goapply' });
    const radios = within(screen.getByRole('radiogroup')).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['简体中文', 'English']);
    expect(screen.getByRole('radio', { name: '简体中文' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the icon menu follows the brand too', () => {
    renderBranded(<LanguageSwitcher />, { brand: 'goapply' });
    fireEvent.click(screen.getByRole('button', { name: '语言' }));
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent?.replace('✓', ''))).toEqual(['简体中文', 'English']);
  });

  it('choosing a language sets the cookie, persists through the brand wrapper and refreshes', () => {
    renderBranded(<LanguageSwitcher variant="full" />, { brand: 'roboapply' });
    fireEvent.click(screen.getByRole('radio', { name: '日本語' }));
    expect(document.cookie).toContain('robo_locale=ja');
    const { url, init } = lastCall();
    expect(url).toMatch(/\/api\/v1\/roboapply\/v2\/preferences\/locale$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'ja' });
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('a failed save (signed out) never blocks the switch', () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 401 }));
    renderBranded(<LanguageSwitcher variant="full" />, { brand: 'roboapply' });
    fireEvent.click(screen.getByRole('radio', { name: 'Deutsch' }));
    expect(document.cookie).toContain('robo_locale=de');
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('re-choosing the current language does nothing', () => {
    renderBranded(<LanguageSwitcher variant="full" />, { brand: 'roboapply' });
    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('holds no raw /api/v1 literal any more (API boundary)', () => {
    const src = readFileSync(join(process.cwd(), 'components/v3/shell/LanguageSwitcher.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toContain('/api/v1/');
  });
});

describe('LanguageMenu (landing)', () => {
  function items(): Array<{ name: string; href: string | null; lang: string | null }> {
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    return screen.getAllByRole('menuitem').map((a) => ({
      name: (a.textContent ?? '').replace('✓', ''),
      href: a.getAttribute('href'),
      lang: a.getAttribute('hreflang'),
    }));
  }

  it('RoboApply: nine crawlable links, English at /', () => {
    renderBranded(<LanguageMenu label="Language" />, { brand: 'roboapply' });
    const list = items();
    expect(list).toHaveLength(9);
    expect(list[0]).toEqual({ name: 'English', href: '/', lang: 'en' });
    expect(list.find((i) => i.lang === 'zh-TW')?.href).toBe('/zh-TW');
  });

  it('GoApply: 简体中文 at / and English at /en, nothing else', () => {
    renderBranded(<LanguageMenu label="Language" />, { brand: 'goapply' });
    expect(items()).toEqual([
      { name: '简体中文', href: '/', lang: 'zh' },
      { name: 'English', href: '/en', lang: 'en' },
    ]);
  });

  it('clicking a language remembers it in the cookie', () => {
    renderBranded(<LanguageMenu label="Language" />, { brand: 'roboapply' });
    fireEvent.click(screen.getByRole('button', { name: 'Language' }));
    const es = screen.getByRole('menuitem', { name: /Español/ });
    es.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(es);
    expect(document.cookie).toContain('robo_locale=es');
  });
});

describe('lib/api/brand', () => {
  it('setLocalePreference PUTs the locale', async () => {
    await expect(setLocalePreference('ko')).resolves.toEqual({ locale: 'ja' });
    const { url, init } = lastCall();
    expect(url).toMatch(/\/api\/v1\/roboapply\/v2\/preferences\/locale$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ locale: 'ko' });
  });

  it('getPublicBrand GETs /api/v1/public/brand', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'goapply' } }), { status: 200 }));
    await expect(getPublicBrand()).resolves.toEqual({ id: 'goapply' });
    expect(lastCall().url).toMatch(/\/api\/v1\/public\/brand$/);
  });
});
