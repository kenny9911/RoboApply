// @vitest-environment node
// WP-18 — scorer v3 (RAJobMatchScorerV3Agent): prompt, input and parsing.
// Lives in the MATCH area (the agent's own colocated test file belongs to FND).
import { describe, expect, it } from 'vitest';

import {
  RAJobMatchScorerV3Agent,
  SCORER_V3_PARSE_EVIDENCE_CAP,
  type RAJobMatchScorerV3Input,
} from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { guardEvidence, MAX_EVIDENCE_PER_DIMENSION } from './evidence.js';

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
