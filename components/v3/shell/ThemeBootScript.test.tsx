// The theme bootstrap script and React's "Encountered a script tag" error
// (verify finding FIX-1 #4: logged on every 404).
//
// Next 16 answers a 404 with an empty `<html id="__next_error__">` shell and
// renders the whole document — root layout included — in the browser. A bare
// <script> in the layout is then CREATED by React on the client, which React
// reports (development) and never executes.
//
// React warns once per module instance, so the order of the tests in this
// file matters: the component first, the bare <script> control last.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { THEME_BOOT_SCRIPT, ThemeBootScript } from './ThemeBootScript';

// Raw createRoot/hydrateRoot (no Testing Library), so say so to React's act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCRIPT_TAG_ERROR = /Encountered a script tag while rendering React component/;
const logged = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((call) => call.map(String).join(' '));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  window.localStorage.clear();
});

describe('ThemeBootScript', () => {
  it('rendered in the browser (a 404) is a data block, and React logs nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<ThemeBootScript />));

    const script = container.querySelector('script')!;
    expect(script.getAttribute('type')).toBe('text/plain');
    expect(logged(errors)).toEqual([]);
    await act(async () => root.unmount());
  });

  it('rendered on the server is an executable inline script', () => {
    // The server has no window; vitest's jsdom does, so take it away for the render.
    vi.stubGlobal('window', undefined);
    const html = renderToString(<ThemeBootScript />);
    vi.unstubAllGlobals();
    expect(html.startsWith('<script>')).toBe(true);
    expect(html).not.toContain('type=');
    expect(html).toContain(THEME_BOOT_SCRIPT);
  });

  it('hydrates over the server script without a warning and leaves it executable', async () => {
    vi.stubGlobal('window', undefined);
    const html = renderToString(<ThemeBootScript />);
    vi.unstubAllGlobals();

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    container.innerHTML = html;
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <ThemeBootScript />);
    });
    expect(container.querySelector('script')!.hasAttribute('type')).toBe(false);
    expect(logged(errors)).toEqual([]);
    await act(async () => root?.unmount());
  });

  it('sets the persisted theme, and only light or dark', () => {
    const run = () => new Function(THEME_BOOT_SCRIPT)();
    window.localStorage.setItem('roboapply:theme:v4', JSON.stringify({ theme: 'dark' }));
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    window.localStorage.setItem('roboapply:theme:v4', JSON.stringify({ theme: 'warm' }));
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    window.localStorage.setItem('roboapply:theme:v4', '{not json');
    expect(run).not.toThrow();
  });

  it('reads the storage key lib/theme.tsx writes', () => {
    const key = /const STORAGE_KEY = '([^']+)'/.exec(readFileSync(join(process.cwd(), 'lib/theme.tsx'), 'utf8'))?.[1];
    expect(key).toBeTruthy();
    expect(THEME_BOOT_SCRIPT).toContain(`localStorage.getItem('${key}')`);
  });
});

describe('control: a bare <script> rendered in the browser', () => {
  it('is what React reports (this is what app/layout.tsx had in <head>)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />));
    expect(logged(errors).some((line) => SCRIPT_TAG_ERROR.test(line))).toBe(true);
    await act(async () => root.unmount());
  });
});
