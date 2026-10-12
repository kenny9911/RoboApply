// @vitest-environment node
// MKT-4G — the scorer pin (MARKET_STRATEGY 2.2 I7, 2.5 row "Scorer model"): one scorer version per market, read
// through brandEnv. (The weights, tiers, priors and budgets of this module are tested in inputs.test.ts.)
import { describe, expect, it } from 'vitest';

import { getBrand } from '../../platform/brand/registry.js';
import { SCORER_V4_PROMPT_VERSION, SCORER_V3_PROMPT_VERSION } from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { DEFAULT_SCORER_RUBRIC, currentScorerPin, promptOfRubric, scorerRubric } from './config.js';
import { FIT_RUBRIC_BY_PROMPT, rubricOfPrompt } from './contract.js';

describe('the scorer pin', () => {
  it('with MATCH_SCORER_RUBRIC unset a new score is fit_v4 on both brands, written by scorer_v4', () => {
    expect(DEFAULT_SCORER_RUBRIC).toBe('fit_v4');
    for (const brand of ['roboapply', 'goapply'] as const) {
      expect(scorerRubric(brand, {}), brand).toBe('fit_v4');
      expect(currentScorerPin(brand, 'vendor/model-a', {}), brand).toEqual({ model: 'vendor/model-a', prompt: 'scorer_v4', rubric: 'fit_v4' });
      expect(currentScorerPin(getBrand(brand), null, {}), brand).toEqual({ model: null, prompt: 'scorer_v4', rubric: 'fit_v4' });
    }
  });

  it('fit_v3 is the rollback: the same deployment writes v3 rows again', () => {
    const env = { MATCH_SCORER_RUBRIC: 'fit_v3' };
    expect(currentScorerPin('roboapply', 'vendor/model-a', env)).toEqual({ model: 'vendor/model-a', prompt: 'scorer_v3', rubric: 'fit_v3' });
    // GoApply has no value of its own: the shared one applies (D5).
    expect(currentScorerPin('goapply', 'vendor/model-a', env)).toEqual({ model: 'vendor/model-a', prompt: 'scorer_v3', rubric: 'fit_v3' });
    expect(scorerRubric('roboapply', { MATCH_SCORER_RUBRIC: ' FIT_V3 ' })).toBe('fit_v3');
    expect(scorerRubric('roboapply', { MATCH_SCORER_RUBRIC: 'fit_v4' })).toBe('fit_v4');
  });

  it('CN_MATCH_SCORER_RUBRIC overrides it for GoApply alone, in either direction', () => {
    expect(scorerRubric('goapply', { MATCH_SCORER_RUBRIC: 'fit_v4', CN_MATCH_SCORER_RUBRIC: 'fit_v3' })).toBe('fit_v3');
    expect(scorerRubric('roboapply', { MATCH_SCORER_RUBRIC: 'fit_v4', CN_MATCH_SCORER_RUBRIC: 'fit_v3' })).toBe('fit_v4');
    expect(scorerRubric('goapply', { MATCH_SCORER_RUBRIC: 'fit_v3', CN_MATCH_SCORER_RUBRIC: 'fit_v4' })).toBe('fit_v4');
    expect(scorerRubric('roboapply', { CN_MATCH_SCORER_RUBRIC: 'fit_v3' })).toBe('fit_v4');
    expect(scorerRubric('goapply', { CN_MATCH_SCORER_RUBRIC: 'fit_v3' })).toBe('fit_v3');
  });

  it('a value that is not a rubric keeps the default: a typo never switches the scorer', () => {
    for (const bad of ['', '   ', 'v3', 'fit_v5', 'scorer_v3', 'true', 'fit_v3,fit_v4']) expect(scorerRubric('roboapply', { MATCH_SCORER_RUBRIC: bad }), bad).toBe('fit_v4');
    // An own value GoApply cannot read falls to the default, not to the shared value: the CN_ value is what was set for it.
    expect(scorerRubric('goapply', { MATCH_SCORER_RUBRIC: 'fit_v3', CN_MATCH_SCORER_RUBRIC: 'nonsense' })).toBe('fit_v4');
  });

  it('the model is the one the caller resolved for the brand; the pin adds nothing to it and reads no model variable', () => {
    const env = { LLM_MATCHING_MODEL: 'shared/model', CN_LLM_MATCHING_MODEL: 'cn/model' };
    expect(currentScorerPin('goapply', 'cn/model', env).model).toBe('cn/model');
    expect(currentScorerPin('goapply', 'shared/model', env).model).toBe('shared/model');
    expect(currentScorerPin('roboapply', null, env).model).toBeNull();
  });

  it('a rubric and its prompt name each other, and the prompt constants of the agents are the ones the contract maps', () => {
    expect(promptOfRubric('fit_v4')).toBe('scorer_v4');
    expect(promptOfRubric('fit_v3')).toBe('scorer_v3');
    for (const [prompt, rubric] of Object.entries(FIT_RUBRIC_BY_PROMPT)) {
      expect(promptOfRubric(rubric)).toBe(prompt);
      expect(rubricOfPrompt(prompt)).toBe(rubric);
    }
    expect(rubricOfPrompt(SCORER_V4_PROMPT_VERSION)).toBe('fit_v4');
    expect(rubricOfPrompt(SCORER_V3_PROMPT_VERSION)).toBe('fit_v3');
  });
});
