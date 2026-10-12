// FIX-6 — the practice length a new user starts on is one their balance covers.
// Run: npx vitest run lib/mockInterviewCredits.test.ts

import { describe, expect, it } from 'vitest';

import {
  canAffordMinutes,
  defaultPracticeMinutes,
  longestAffordableMinutes,
  mockCreditsForMinutes,
} from './mockInterviewCredits';

const OPTIONS = [15, 30, 45, 60];

describe('defaultPracticeMinutes', () => {
  it('keeps the type’s own length when the balance covers it', () => {
    expect(defaultPracticeMinutes({ preferred: 45, options: OPTIONS, balance: 3, creditMinutes: 20 })).toBe(45);
  });

  it('a new user with one credit starts on 15 minutes, not on a 45-minute plan they cannot start', () => {
    // The QA run: 45 minutes costs 2.25 credits, the balance is 1.
    expect(mockCreditsForMinutes(45, 20)).toBe(2.25);
    expect(defaultPracticeMinutes({ preferred: 45, options: OPTIONS, balance: 1, creditMinutes: 20 })).toBe(15);
    // GoApply's 50-minute live-coding default with one credit.
    expect(defaultPracticeMinutes({ preferred: 50, options: [15, 30, 45, 50, 60], balance: 1, creditMinutes: 20 })).toBe(15);
    // The AI-interview format offers 20, 25 and 30 minutes: one credit covers 20.
    expect(defaultPracticeMinutes({ preferred: 25, options: [20, 25, 30], balance: 1, creditMinutes: 20 })).toBe(20);
  });

  it('picks the longest length the balance covers', () => {
    expect(defaultPracticeMinutes({ preferred: 60, options: OPTIONS, balance: 2, creditMinutes: 20 })).toBe(30);
    expect(defaultPracticeMinutes({ preferred: 60, options: OPTIONS, balance: 2.25, creditMinutes: 20 })).toBe(45);
  });

  it('keeps the type’s own length when the balance is unknown or covers nothing', () => {
    expect(defaultPracticeMinutes({ preferred: 45, options: OPTIONS, balance: undefined, creditMinutes: 20 })).toBe(45);
    expect(defaultPracticeMinutes({ preferred: 45, options: OPTIONS, balance: null, creditMinutes: 20 })).toBe(45);
    expect(defaultPracticeMinutes({ preferred: 45, options: OPTIONS, balance: 0, creditMinutes: 20 })).toBe(45);
    expect(defaultPracticeMinutes({ preferred: 45, options: OPTIONS, balance: 0.5, creditMinutes: 20 })).toBe(45);
  });
});

describe('longestAffordableMinutes / canAffordMinutes', () => {
  it('returns null when nothing is covered and tolerates float dust in the balance', () => {
    expect(longestAffordableMinutes(OPTIONS, 0.74, 20)).toBeNull();
    expect(longestAffordableMinutes(OPTIONS, 0.75, 20)).toBe(15);
    expect(longestAffordableMinutes(OPTIONS, 0.1 + 0.2 + 0.45, 20)).toBe(15);
    expect(canAffordMinutes(30, 1.4999999999, 20)).toBe(true);
    expect(canAffordMinutes(30, 1.49, 20)).toBe(false);
  });
});
