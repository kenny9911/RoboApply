// Smoke test — proves the vitest runner is wired up. Replace as real
// component / hook / lib tests land.

import { describe, expect, it } from 'vitest';

describe('roboapply-app scaffold', () => {
  it('basic arithmetic works', () => {
    expect(1 + 1).toBe(2);
  });

  it('exposes process.env.NEXT_PUBLIC_API_URL during tests', () => {
    // vitest doesn't load Next env automatically, but the variable should at
    // least be undefined-or-string, never a thrown error.
    const value = process.env.NEXT_PUBLIC_API_URL;
    expect(value === undefined || typeof value === 'string').toBe(true);
  });
});
