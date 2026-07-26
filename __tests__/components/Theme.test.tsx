// lib/theme.tsx — the whole appearance surface, which is now one bit.
//
// Covers: the light default, the v4 storage key, persistence across a
// remount, toggle()/setTheme() round-trips, the <html data-theme> write, and
// the fallback when the persisted payload is legacy or garbage. The v3 key
// (`roboapply:dc-theme:v3`) carried accent / density / aggressiveness / tone
// and a third `warm` theme; none of that exists any more, and reading a
// stale payload must land on light rather than on an invalid value.

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { DEFAULT_THEME, ThemeProvider, useTheme } from '../../lib/theme';

const STORAGE_KEY = 'roboapply:theme:v4';

/** Reads the live context and exposes both write paths as buttons. */
function Probe() {
  const { theme, setTheme, toggle, hydrated } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="hydrated">{String(hydrated)}</span>
      <button type="button" onClick={toggle}>
        toggle
      </button>
      <button type="button" onClick={() => setTheme('dark')}>
        set dark
      </button>
      <button type="button" onClick={() => setTheme('light')}>
        set light
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

function persisted(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
}

describe('lib/theme', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to light with nothing persisted', () => {
    renderProvider();
    expect(DEFAULT_THEME.theme).toBe('light');
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('reports hydrated after mount so theme-conditional markup can render', () => {
    renderProvider();
    // The mount effect has already flushed inside act() by the time render
    // returns; consumers gate their icon/aria-label on this.
    expect(screen.getByTestId('hydrated').textContent).toBe('true');
  });

  it('toggles light ⇄ dark and writes <html data-theme> + color-scheme', () => {
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('persists under the v4 key and reloads it on a fresh mount', () => {
    const first = renderProvider();
    fireEvent.click(screen.getByRole('button', { name: 'set dark' }));
    expect(persisted()).toBe(JSON.stringify({ theme: 'dark' }));
    first.unmount();

    // A brand-new provider seeds from localStorage in its useState initializer,
    // so the very first render is already dark (that's the no-flash contract).
    renderProvider();
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('setTheme is idempotent and survives a round-trip back to light', () => {
    renderProvider();
    fireEvent.click(screen.getByRole('button', { name: 'set dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'set dark' }));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'set light' }));
    expect(persisted()).toBe(JSON.stringify({ theme: 'light' }));
  });

  it('falls back to light for a legacy v3-shaped payload (theme: warm + knobs)', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        theme: 'warm',
        accent: 'lime',
        density: 'comfy',
        aggressiveness: 'intense',
        tone: 'witty',
      }),
    );
    renderProvider();
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('falls back to light for an unparseable payload', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not json');
    renderProvider();
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });

  it('keeps a valid dark payload but drops the dead knobs alongside it', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme: 'dark', accent: 'pink' }),
    );
    renderProvider();
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    // Only `theme` is written back — nothing re-persists the stale knob.
    expect(persisted()).toBe(JSON.stringify({ theme: 'dark' }));
  });

  it('useTheme outside a provider returns safe, inert defaults', () => {
    render(<Probe />);
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(screen.getByTestId('hydrated').textContent).toBe('false');
    // The no-op setters must not throw.
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('theme').textContent).toBe('light');
  });
});
