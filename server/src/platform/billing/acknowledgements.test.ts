// @vitest-environment node
//
// The one list of billing countries with a statutory right of withdrawal
// (ST-9; MARKET_STRATEGY.md §4.4): EU 27 + IS, LI, NO + GB + TW.
import { describe, expect, it } from 'vitest';
import { EU_COUNTRIES, WITHDRAWAL_COUNTRIES, showsWithdrawalWaiver, withdrawalRegion } from './acknowledgements.js';

describe('WITHDRAWAL_COUNTRIES', () => {
  it('has 32 entries, none twice, all upper-case ISO alpha-2', () => {
    expect(WITHDRAWAL_COUNTRIES).toHaveLength(32);
    expect(new Set(WITHDRAWAL_COUNTRIES).size).toBe(32);
    for (const c of WITHDRAWAL_COUNTRIES) expect(c).toMatch(/^[A-Z]{2}$/);
  });

  it('is the EU 27, the three EEA states outside the EU, the United Kingdom and Taiwan', () => {
    expect(EU_COUNTRIES).toHaveLength(27);
    expect([...WITHDRAWAL_COUNTRIES].sort()).toEqual([...EU_COUNTRIES, 'IS', 'LI', 'NO', 'GB', 'TW'].sort());
  });

  it('every entry maps to a region and shows the waiver box', () => {
    for (const c of WITHDRAWAL_COUNTRIES) {
      expect(withdrawalRegion(c), c).not.toBeNull();
      expect(withdrawalRegion(c.toLowerCase()), c).toBe(withdrawalRegion(c));
      expect(showsWithdrawalWaiver(c), c).toBe(true);
    }
    expect(withdrawalRegion('NO')).toBe('eu');
    expect(withdrawalRegion('GB')).toBe('uk');
    expect(withdrawalRegion('TW')).toBe('tw');
  });

  it('a country outside the list has no region (the list and the region rule agree)', () => {
    for (const c of ['US', 'CA', 'CH', 'AU', 'SG', 'JP', 'CN', 'HK']) {
      expect((WITHDRAWAL_COUNTRIES as readonly string[]).includes(c), c).toBe(false);
      expect(withdrawalRegion(c), c).toBeNull();
    }
    // 'UK' is read as the United Kingdom although the ISO code in the list is GB.
    expect(withdrawalRegion('UK')).toBe('uk');
  });
});
