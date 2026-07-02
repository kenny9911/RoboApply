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
