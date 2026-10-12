// @vitest-environment node
//
// The MATCH area's public surface exports the limits other areas display
// (WP-93: the admin "Limits" page reads them from here instead of a copy).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import * as config from './config.js';
import * as match from './index.js';

describe('match/index.ts limit exports', () => {
  it('scoreDailyBudget and scoreCounterKeys are the config module’s own (no second definition)', () => {
    expect(match.scoreDailyBudget).toBe(config.scoreDailyBudget);
    expect(match.scoreCounterKeys).toBe(config.scoreCounterKeys);
  });

  it('scoreDailyBudget reads the brand’s env name with the default behind it', () => {
    expect(match.scoreDailyBudget('roboapply', {})).toBe(config.DEFAULT_SCORE_DAILY_BUDGET);
    expect(match.scoreDailyBudget('roboapply', { SCORE_DAILY_BUDGET: '1200' })).toBe(1200);
    expect(match.scoreDailyBudget('goapply', { SCORE_DAILY_BUDGET: '1200', CN_SCORE_DAILY_BUDGET: '300' })).toBe(300);
  });

  it('scoreCounterKeys names one counter per brand budget and per user', () => {
    expect(match.scoreCounterKeys.budget('goapply')).toBe('budget:llm:score:goapply');
    expect(match.scoreCounterKeys.onDemand('roboapply', 'u1')).toBe('match:roboapply:score:user:u1');
    expect(match.scoreCounterKeys.precompute('roboapply', 'u1')).toBe('match:roboapply:precompute:user:u1');
  });

  it('splitSkills is exported for the feed’s "Why this job" lines', () => {
    expect(typeof match.splitSkills).toBe('function');
  });
});
