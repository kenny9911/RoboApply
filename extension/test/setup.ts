// extension/test/setup.ts — jsdom setup for the extension's unit tests.

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  if (typeof document !== 'undefined') document.body.innerHTML = '';
});

// Node 26 exposes undefined Web Storage globals that block jsdom's own.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    if (typeof window !== 'undefined' && !window[name]) throw new Error('missing');
  } catch {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      },
    });
  }
}
