// roboapply-app/__tests__/setup.ts
//
// Vitest setup. Pulls in jest-dom matchers and provides a few jsdom
// polyfills the app expects (matchMedia, ResizeObserver).

import { afterEach, expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

expect.extend(matchers as Parameters<typeof expect.extend>[0]);

afterEach(() => {
  cleanup();
});

// JSDOM doesn't ship matchMedia. Some components branch on mobile-vs-desktop
// breakpoints at mount time; without this they throw.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Node 26 exposes experimental Web Storage globals that are UNDEFINED unless
// `--localstorage-file` is passed — and their mere presence on the Node global
// stops vitest's jsdom environment from installing jsdom's real implementation
// (it won't shadow existing Node globals). Shim a Map-backed Storage so
// anything touching localStorage/sessionStorage keeps working under Node 26+.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  } as Storage;
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (typeof window !== 'undefined' && !window[name]) {
    Object.defineProperty(window, name, {
      configurable: true,
      value: createMemoryStorage(),
    });
  }
}

// JSDOM lacks ResizeObserver. Several heroicons/animation libraries called
// at render time use it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// JSDOM doesn't implement scrollTo on elements.
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollTo = function scrollTo() {};
}

// Silence the React 19 act() warning for these tests — most of our state
// updates land inside fireEvent/userEvent which already wrap with act().
const originalError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && first.includes('not wrapped in act')) {
    return;
  }
  originalError(...args);
};
