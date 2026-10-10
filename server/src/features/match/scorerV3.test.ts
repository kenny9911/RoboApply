// @vitest-environment node
// WP-18 — scorer v3 (RAJobMatchScorerV3Agent): prompt, input and parsing.
// Lives in the MATCH area (the agent's own colocated test file belongs to FND).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithBrand } from '../../lib/requestContext.js';
import { getBrand } from '../../platform/brand/registry.js';
import {
  RAJobMatchScorerV3Agent,
  SCORER_V3_PARSE_EVIDENCE_CAP,
  resolvedJobMatchScorerModel,
  type RAJobMatchScorerV3Input,
} from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { guardEvidence, MAX_EVIDENCE_PER_DIMENSION } from './evidence.js';
import { defaultScorerRouteAllowed } from './scorerRoute.js';

class V3Probe extends RAJobMatchScorerV3Agent {
  prompt() {
    return this.getAgentPrompt();
  }
  input(i: RAJobMatchScorerV3Input) {
    return this.formatInput(i);
  }
  parse(r: string) {
    return this.parseOutput(r);
  }
  maxTokens() {
    return this.getMaxTokens();
  }
}

const v3 = new V3Probe();
const V3_INPUT: RAJobMatchScorerV3Input = {
  resumeMarkdown: '# [removed]\nSenior engineer at PayCo',
  profileContext: null,
  job: { title: 'Backend Engineer', companyName: 'Acme', seniority: 'senior', educationLevel: 'master', minYears: 5, skills: ['go'], description: 'Build APIs.', qualifications: 'Go' },
  logistics: { score: 100, lines: ['Location: fits what the candidate asked for'] },
  targets: { titles: ['Backend Engineer'], seniority: ['senior'] },
};

describe('RAJobMatchScorerV3Agent', () => {
  it('asks for four components and never a total; bans school tier and sensitive attributes', () => {
    const p = v3.prompt();
    expect(p).toMatch(/Never output a total/);
    expect(p).toMatch(/985\/211\/双一流/);
    expect(p).toMatch(/籍贯/);
    expect(p).toMatch(/EXACT quote/);
    expect(p).not.toMatch(/"score": 0\.\.100,\n  "summary"/);
    expect(v3.maxTokens()).toBeGreaterThanOrEqual(1500);
  });

  it('gives logistics as facts and states the posting requirements', () => {
    const text = v3.input(V3_INPUT);
    expect(text).toContain('Location: fits what the candidate asked for');
    expect(text).toContain('Degree the post asks for: master');
    expect(text).toContain('Years of experience the post asks for: 5+');
    expect(text).not.toContain('Candidate profile');
  });

  it('parses components; industry/career_path may be null; title_level/skills may not', () => {
    const ok = v3.parse(
      JSON.stringify({
        dimensions: {
          title_level: { score: 88.6, evidence: [{ text: ' Senior engineer ', source: 'resume' }, { text: 'x', source: 'elsewhere' }] },
          skills: { score: '70', evidence: [] },
          industry: { score: null },
          career_path: { score: 140, evidence: 'nope' },
        },
        total: 95,
        strengths: ['a', '', 3],
        gaps: [],
        keywordsMatched: ['Go'],
        keywordsMissing: [],
        summary: 'Your Go work fits.',
      }),
    );
    expect(ok.dimensions.title_level).toEqual({ score: 89, evidence: [{ text: 'Senior engineer', source: 'resume' }] });
    expect(ok.dimensions.skills.score).toBe(70);
    expect(ok.dimensions.industry).toEqual({ score: null, evidence: [] });
    expect(ok.dimensions.career_path.score).toBe(100);
    expect(ok.strengths).toEqual(['a']);
    expect(ok).not.toHaveProperty('total');
    expect(ok.summary).toBe('Your Go work fits.');

    expect(() => v3.parse('{"dimensions":{"skills":{"score":1},"industry":{"score":null},"career_path":{"score":null}}}')).toThrow(/title_level/);
    expect(() => v3.parse('{"dimensions":{"title_level":{"score":null},"skills":{"score":1},"industry":{"score":1},"career_path":{"score":1}}}')).toThrow(/title_level/);
    expect(() => v3.parse('not json')).toThrow(/unparseable/);
    expect(() => v3.parse('{"score": 80}')).toThrow(/dimensions/);
  });

  it('drops a summary that states a score', () => {
    const base = { dimensions: { title_level: { score: 1 }, skills: { score: 1 }, industry: { score: 1 }, career_path: { score: 1 } } };
    expect(v3.parse(JSON.stringify({ ...base, summary: 'An 85/100 fit for you.' })).summary).toBeNull();
    expect(v3.parse(JSON.stringify({ ...base, summary: '匹配度 85分' })).summary).toBeNull();
    expect(v3.parse('```json\n' + JSON.stringify({ ...base, summary: 'Your 5 years in Go help.' }) + '\n```').summary).toBe('Your 5 years in Go help.');
  });
});

describe('evidence caps', () => {
  it('parsing keeps more quotes than the card shows, so the guard can drop invented ones first', () => {
    const quotes = Array.from({ length: 8 }, (_, i) => ({ text: `quote number ${i}`, source: 'resume' }));
    const base = { title_level: { score: 1 }, industry: { score: 1 }, career_path: { score: 1 } };
    const parsed = v3.parse(JSON.stringify({ dimensions: { ...base, skills: { score: 50, evidence: quotes } } }));
    expect(parsed.dimensions.skills.evidence).toHaveLength(SCORER_V3_PARSE_EVIDENCE_CAP);
    expect(SCORER_V3_PARSE_EVIDENCE_CAP).toBeGreaterThan(MAX_EVIDENCE_PER_DIMENSION);

    // Quotes 0 and 2 are invented; the valid 4th quote (index 3) survives.
    const resume = 'quote number 1. quote number 3. quote number 4. quote number 5.';
    const kept = guardEvidence(parsed.dimensions.skills.evidence, { resume, posting: '' });
    expect(kept.map((e) => e.text)).toEqual(['quote number 1', 'quote number 3', 'quote number 4']);
  });
});

// ── D5: the scorer model on GoApply (GOAPPLY_PARITY_PLAN.md §3.3) ────────────

describe('scorer model per brand (D5)', () => {
  const NAMES = ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_MATCHING_MODEL', 'CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_MATCHING_MODEL', 'CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT'];
  beforeEach(() => {
    for (const name of NAMES) vi.stubEnv(name, '');
    vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('GoApply with only LLM_MODEL set gets an AI score: the same scorer model as RoboApply, on an allowed route', async () => {
    vi.stubEnv('LLM_MODEL', 'openrouter/openai/gpt-6-luna');
    const goModel = runWithBrand('goapply', () => resolvedJobMatchScorerModel());
    const roboModel = runWithBrand('roboapply', () => resolvedJobMatchScorerModel());
    expect(goModel).toBe('openrouter/openai/gpt-6-luna');
    expect(goModel).toBe(roboModel);
    // MatchService asks this before every scorer call; false would mean the deterministic quick estimate only.
    expect(await defaultScorerRouteAllowed(getBrand('goapply'), goModel)).toBe(true);
    expect(await defaultScorerRouteAllowed(getBrand('roboapply'), roboModel)).toBe(true);

    // The matching task model is shared per key too.
    vi.stubEnv('LLM_MATCHING_MODEL', 'google/gemini-3.8-flash');
    expect(runWithBrand('goapply', () => resolvedJobMatchScorerModel())).toBe('google/gemini-3.8-flash');
    expect(await defaultScorerRouteAllowed(getBrand('goapply'), 'google/gemini-3.8-flash')).toBe(true);
  });

  it('GoApply\'s own matching model wins; behind the wall an international scorer model means the quick estimate', async () => {
    vi.stubEnv('LLM_MODEL', 'openrouter/openai/gpt-6-luna');
    vi.stubEnv('CN_LLM_PROVIDER', 'deepseek');
    vi.stubEnv('CN_LLM_MATCHING_MODEL', 'deepseek/deepseek-v4-flash');
    expect(runWithBrand('goapply', () => resolvedJobMatchScorerModel())).toBe('deepseek/deepseek-v4-flash');
    expect(runWithBrand('roboapply', () => resolvedJobMatchScorerModel())).toBe('openrouter/openai/gpt-6-luna');
    expect(await defaultScorerRouteAllowed(getBrand('goapply'), 'deepseek/deepseek-v4-flash')).toBe(true);

    vi.stubEnv('CN_LLM_DOMESTIC_ONLY', 'true');
    expect(await defaultScorerRouteAllowed(getBrand('goapply'), 'deepseek/deepseek-v4-flash')).toBe(true);
    expect(await defaultScorerRouteAllowed(getBrand('goapply'), 'openrouter/openai/gpt-6-luna')).toBe(false);
    expect(await defaultScorerRouteAllowed(getBrand('roboapply'), 'openrouter/openai/gpt-6-luna')).toBe(true);
  });

  it('behind the wall a shared matching model does not shadow GoApply\'s own mainland default: the AI score stays on', async () => {
    vi.stubEnv('LLM_MODEL', 'openrouter/openai/gpt-6-luna');
    vi.stubEnv('LLM_MATCHING_MODEL', 'google/gemini-3.8-flash'); // RoboApply's, set for the whole deployment
    vi.stubEnv('CN_LLM_PROVIDER', 'deepseek');
    vi.stubEnv('CN_LLM_MODEL', 'deepseek-v4-flash');
    vi.stubEnv('CN_LLM_DOMESTIC_ONLY', 'true');
    const goModel = runWithBrand('goapply', () => resolvedJobMatchScorerModel());
    expect(goModel).toBe('deepseek-v4-flash');
    expect(await defaultScorerRouteAllowed(getBrand('goapply'), goModel)).toBe(true);
    expect(runWithBrand('roboapply', () => resolvedJobMatchScorerModel())).toBe('google/gemini-3.8-flash');
    // With no mainland model of its own GoApply has no scorer model (the quick estimate), never the shared one.
    vi.stubEnv('CN_LLM_PROVIDER', '');
    vi.stubEnv('CN_LLM_MODEL', '');
    expect(() => runWithBrand('goapply', () => resolvedJobMatchScorerModel())).toThrow(/not configured/);
  });

  it('with no model at all the scorer has none on either brand', () => {
    expect(() => runWithBrand('goapply', () => resolvedJobMatchScorerModel())).toThrow(/not configured/);
    expect(() => runWithBrand('roboapply', () => resolvedJobMatchScorerModel())).toThrow(/not configured/);
  });
});
