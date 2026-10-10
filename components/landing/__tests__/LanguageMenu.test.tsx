// The landing language menu (FIX-7): choosing a language must reload the
// document, because the locale and its messages belong to the root layout,
// which a client-side navigation keeps mounted (URL and title changed, the
// page stayed in the old language). And the button says what it does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

// A stand-in for next/link that marks itself, so a soft navigation is visible.
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} data-soft-nav="" {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({}),
}));

import type * as React from 'react';

import { renderBranded } from '../../../__tests__/brand/helpers';
import { LanguageMenu } from '../LanguageMenu';

beforeEach(() => {
  document.cookie = 'robo_locale=; max-age=0; path=/';
});
afterEach(cleanup);

describe('LanguageMenu', () => {
  it('names the button "Change language" in the page language, never the nav label', () => {
    renderBranded(<LanguageMenu />, { brand: 'roboapply' });
    const button = screen.getByRole('button', { name: 'Change language' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByRole('button', { name: 'Main' })).toBeNull();
    cleanup();
    renderBranded(<LanguageMenu />, { brand: 'goapply' });
    expect(screen.getByRole('button', { name: '切换语言' })).toBeInTheDocument();
  });

  it('every language is a plain anchor (a full document load), not a client-side link', () => {
    renderBranded(<LanguageMenu />, { brand: 'roboapply' });
    fireEvent.click(screen.getByRole('button', { name: 'Change language' }));
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect(item.tagName).toBe('A');
      expect(item).not.toHaveAttribute('data-soft-nav');
    }
    const zhTw = items.find((a) => a.getAttribute('hreflang') === 'zh-TW')!;
    expect(zhTw).toHaveAttribute('href', '/zh-TW');
    expect(zhTw).toHaveAttribute('lang', 'zh-TW');
  });

  it('a click sets the cookie and leaves the navigation to the browser', () => {
    renderBranded(<LanguageMenu />, { brand: 'roboapply' });
    fireEvent.click(screen.getByRole('button', { name: 'Change language' }));
    const zhTw = screen.getByRole('menuitem', { name: /繁體中文/ });
    let prevented: boolean | null = null;
    // Registered on the document: runs after the component's own handler.
    const spy = (e: Event) => {
      prevented = e.defaultPrevented;
      e.preventDefault(); // jsdom does not navigate; keep it quiet
    };
    document.addEventListener('click', spy);
    fireEvent.click(zhTw);
    document.removeEventListener('click', spy);
    expect(document.cookie).toContain('robo_locale=zh-TW');
    expect(prevented).toBe(false);
    // The anchor is still in the document when the browser acts on the click.
    expect(zhTw.isConnected).toBe(true);
  });

  it('a page restored from the back-forward cache does not come back with the menu open', () => {
    renderBranded(<LanguageMenu />, { brand: 'roboapply' });
    fireEvent.click(screen.getByRole('button', { name: 'Change language' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent(window, new Event('pagehide'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('marks the current language', () => {
    renderBranded(<LanguageMenu />, { brand: 'goapply' });
    fireEvent.click(screen.getByRole('button', { name: '切换语言' }));
    expect(screen.getByRole('menuitem', { name: /简体中文/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('menuitem', { name: /English/ })).not.toHaveAttribute('aria-current');
  });
});
