// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  TW_COUNTIES,
  TwProfileFieldsSchema,
  hasTwAnswers,
  isTaiwanRelevant,
  readTwProfileFields,
} from './index.js';

describe('Taiwan profile deltas (TW-04)', () => {
  it('lists the 22 counties and cities once each', () => {
    expect(TW_COUNTIES).toHaveLength(22);
    expect(new Set(TW_COUNTIES).size).toBe(22);
  });

  it.each([
    [{ desiredTitles: ['後端工程師'], desiredLocations: ['TPE', 'NWT'], desiredPay: { kind: 'monthly', range: { min: 50000, max: 70000 } } }, true],
    [{ desiredPay: { kind: 'negotiable' } }, true], // 面議
    [{ desiredPay: { kind: 'company_policy' } }, true], // 依公司規定
    [{ desiredPay: { kind: 'annual', range: { min: null, max: 1_200_000 } } }, true],
    [{ desiredLocations: ['ANY'] }, true],
    [{ desiredPay: { kind: 'monthly', range: { min: 80000, max: 50000 } } }, false], // min > max
    [{ desiredPay: { kind: 'monthly', range: { min: null, max: null } } }, false], // no amount
    [{ desiredPay: { kind: 'monthly', range: { min: 50_000_000, max: null } } }, false], // over the cap
    [{ desiredPay: { kind: 'negotiable', range: { min: 1, max: 2 } } }, false], // 面議 carries no number
    [{ desiredLocations: ['TPE', 'TPE'] }, false],
    [{ desiredLocations: ['XXX'] }, false],
    [{ desiredTitles: ['a', 'b', 'c', 'd', 'e', 'f'] }, false],
    [{ salary: 1 }, false], // strict
  ])('validates %j → %s', (value, ok) => {
    expect(TwProfileFieldsSchema.safeParse(value).success).toBe(ok);
  });

  it('reads stored values tolerantly', () => {
    expect(readTwProfileFields(null)).toBeNull();
    expect(readTwProfileFields({ desiredPay: { kind: 'bogus' } })).toBeNull();
    expect(readTwProfileFields({ desiredTitles: ['PM'] })).toEqual({ desiredTitles: ['PM'] });
  });

  it('knows when there is an answer', () => {
    expect(hasTwAnswers(null)).toBe(false);
    expect(hasTwAnswers({})).toBe(false);
    expect(hasTwAnswers({ desiredTitles: [] })).toBe(false);
    expect(hasTwAnswers({ desiredPay: { kind: 'negotiable' } })).toBe(true);
  });

  it('offers the Taiwan section only on the international brand, when Taiwan is relevant', () => {
    expect(isTaiwanRelevant({ market: 'cn', country: 'TW' })).toBe(false);
    expect(isTaiwanRelevant({ market: 'intl', country: 'US' })).toBe(false);
    expect(isTaiwanRelevant({ market: 'intl', country: 'TW' })).toBe(true);
    expect(isTaiwanRelevant({ market: 'intl', workAuthCountries: ['US', 'TW'] })).toBe(true);
    expect(isTaiwanRelevant({ market: 'intl', locale: 'zh-TW' })).toBe(true);
    expect(isTaiwanRelevant({ market: 'intl', hasAnswers: true })).toBe(true);
  });
});
