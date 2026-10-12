// @vitest-environment node
//
// The interview skill registry (skills/index.ts, markets.ts, patterns.ts):
// the compact index a planner chooses from, the per-stage directives the
// chosen ids expand into, the catalog persona a generated interviewer runs
// on, and the market a practice's norms come from. Pure data; nothing mocked.
// Run: npx vitest run server/src/interview-engine/skills/skills.test.ts

import { describe, expect, it } from 'vitest';
import { INTERVIEW_ARCHETYPES } from '../catalog/interviewArchetypes.js';
import { INTERVIEW_PERSONAS } from '../catalog/interviewCatalog.js';
import { formatsForMarket, getFormat } from '../catalog/interviewFormats.js';
import {
  INTERVIEW_MARKET_KEYS,
  INTERVIEW_PATTERNS,
  INTERVIEW_PATTERN_KEYS,
  MARKET_NORMS,
  basePersonaFor,
  cleanPatternKeys,
  formatOrDefault,
  getMarketNorms,
  getPattern,
  isMarketFormat,
  marketDirectives,
  marketForCountry,
  patternDirectives,
  renderSkillIndex,
  resolveMarketNorms,
} from './index.js';

describe('the skill data', () => {
  it('has 23 patterns and 12 markets, each keyed by its own id', () => {
    expect(INTERVIEW_PATTERN_KEYS).toHaveLength(23);
    expect(INTERVIEW_MARKET_KEYS).toHaveLength(12);
    for (const key of INTERVIEW_PATTERN_KEYS) expect(INTERVIEW_PATTERNS[key].key).toBe(key);
    for (const key of INTERVIEW_MARKET_KEYS) expect(MARKET_NORMS[key].key).toBe(key);
  });

  it('every pattern names real formats and archetypes', () => {
    for (const key of INTERVIEW_PATTERN_KEYS) {
      const pattern = INTERVIEW_PATTERNS[key];
      expect(pattern.formats.length, key).toBeGreaterThan(0);
      for (const format of pattern.formats) expect(getFormat(format), `${key} → ${format}`).toBeDefined();
      for (const archetype of pattern.archetypes) expect(INTERVIEW_ARCHETYPES, `${key} → ${archetype}`).toContain(archetype);
    }
  });

  it('every market playbook keeps the protected-trait guardrail in its live directive', () => {
    for (const key of INTERVIEW_MARKET_KEYS) {
      expect(MARKET_NORMS[key].voiceDirective, key).toContain('Never ask about age, family plans, marital status');
    }
  });

  it('lookups by id ignore unknown and prototype names', () => {
    expect(getPattern('bar-raiser')?.key).toBe('bar-raiser');
    for (const bad of ['nope', 'constructor', '__proto__', 'toString', '', null, undefined]) {
      expect(getPattern(bad)).toBeNull();
      expect(getMarketNorms(bad)).toBeNull();
    }
  });
});

describe('renderSkillIndex', () => {
  const lines = (text: string) => text.split('\n').filter((line) => line.startsWith('- '));

  it.each(['intl', 'cn'] as const)('lists every %s format id, every archetype and every pattern key, and nothing else', (market) => {
    const index = renderSkillIndex(market);
    const formats = formatsForMarket(market);
    for (const format of formats) expect(index).toContain(`- ${format.id}: ${format.labelEn} — `);
    for (const archetype of INTERVIEW_ARCHETYPES) expect(index).toMatch(new RegExp(`^- ${archetype}: `, 'm'));
    for (const key of INTERVIEW_PATTERN_KEYS) expect(index).toContain(`- ${key}: ${INTERVIEW_PATTERNS[key].labelEn} — `);
    expect(lines(index)).toHaveLength(formats.length + INTERVIEW_ARCHETYPES.length + INTERVIEW_PATTERN_KEYS.length);
  });

  it('offers the GoApply AI-interview format on the cn index only', () => {
    expect(renderSkillIndex('cn')).toContain('- cn_ai_interview: ');
    expect(renderSkillIndex('intl')).not.toContain('cn_ai_interview');
    // The default is the international list.
    expect(renderSkillIndex()).toBe(renderSkillIndex('intl'));
    expect(lines(renderSkillIndex('cn')).length).toBe(lines(renderSkillIndex('intl')).length + 1);
  });
});

describe('patternDirectives', () => {
  it('expands known keys into the three stages, labelled, in order; unknown keys are ignored', () => {
    const out = patternDirectives(['nope', 'bar-raiser', 'constructor', '__proto__', 'hr-final']);
    const barRaiser = INTERVIEW_PATTERNS['bar-raiser'];
    const hrFinal = INTERVIEW_PATTERNS['hr-final'];
    expect(out).toEqual({
      blueprint: [`${barRaiser.labelEn}: ${barRaiser.blueprintDirective}`, `${hrFinal.labelEn}: ${hrFinal.blueprintDirective}`],
      voice: [`${barRaiser.labelEn}: ${barRaiser.voiceDirective}`, `${hrFinal.labelEn}: ${hrFinal.voiceDirective}`],
      evaluation: [`${barRaiser.labelEn}: ${barRaiser.evaluationLens}`, `${hrFinal.labelEn}: ${hrFinal.evaluationLens}`],
    });
  });

  it('is empty for no or only unknown keys', () => {
    expect(patternDirectives([])).toEqual({ blueprint: [], voice: [], evaluation: [] });
    expect(patternDirectives(['made-up', 'also-made-up'])).toEqual({ blueprint: [], voice: [], evaluation: [] });
  });
});

describe('cleanPatternKeys', () => {
  it('keeps known keys, trimmed, in order, without duplicates, up to the cap', () => {
    expect(cleanPatternKeys([' bar-raiser ', 'nope', 'bar-raiser', 'hr-final', 3, null, 'cross-team', 'group-discussion', 'one-way-video'])).toEqual([
      'bar-raiser',
      'hr-final',
      'cross-team',
      'group-discussion',
    ]);
    expect(cleanPatternKeys(['bar-raiser', 'hr-final', 'cross-team'], 2)).toEqual(['bar-raiser', 'hr-final']);
    expect(cleanPatternKeys('bar-raiser')).toEqual([]);
    expect(cleanPatternKeys(undefined)).toEqual([]);
  });
});

describe('marketDirectives', () => {
  it('returns the market playbook per stage, or null for an unknown market', () => {
    expect(marketDirectives('jp')).toEqual({
      label: 'Japan',
      blueprint: [MARKET_NORMS.jp.blueprintDirective],
      voice: [MARKET_NORMS.jp.voiceDirective],
      evaluation: [MARKET_NORMS.jp.evaluationLens],
    });
    expect(marketDirectives('mars')).toBeNull();
    expect(marketDirectives(null)).toBeNull();
    expect(marketDirectives('hasOwnProperty')).toBeNull();
  });
});

describe('formats per market', () => {
  it('isMarketFormat: the AI-interview format exists on cn only; shared formats on both', () => {
    expect(isMarketFormat('cn_ai_interview', 'cn')).toBe(true);
    expect(isMarketFormat('cn_ai_interview', 'intl')).toBe(false);
    expect(isMarketFormat('cn_ai_interview')).toBe(false);
    expect(isMarketFormat('technical', 'cn')).toBe(true);
    expect(isMarketFormat('technical', 'intl')).toBe(true);
    expect(isMarketFormat(42, 'intl')).toBe(false);
  });

  it('formatOrDefault keeps a valid id and falls back to behavioral', () => {
    expect(formatOrDefault('system')).toBe('system');
    expect(formatOrDefault('cn_ai_interview', 'cn')).toBe('cn_ai_interview');
    expect(formatOrDefault('cn_ai_interview', 'intl')).toBe('behavioral');
    expect(formatOrDefault('interpretive_dance', 'cn')).toBe('behavioral');
    expect(formatOrDefault(undefined)).toBe('behavioral');
  });
});

describe('basePersonaFor', () => {
  const genders = ['female', 'male'] as const;

  it('always keeps the archetype, and the voice gender wherever a persona of that archetype has it', () => {
    for (const archetype of INTERVIEW_ARCHETYPES) {
      for (const voiceGender of [...genders, null]) {
        for (const difficulty of [1, 2, 3]) {
          const persona = basePersonaFor({ archetype, difficulty, voiceGender });
          expect(persona.archetype, `${archetype}/${voiceGender}/${difficulty}`).toBe(archetype);
          const voiceExists = INTERVIEW_PERSONAS.some((p) => p.archetype === archetype && p.voiceGender === voiceGender);
          if (voiceGender && voiceExists) expect(persona.voiceGender, `${archetype}/${voiceGender}/${difficulty}`).toBe(voiceGender);
        }
      }
    }
  });

  it('prefers the voice gender over the closest difficulty', () => {
    // Behavioral: priya (2, female), bishop (3, male), osei (2, male).
    expect(basePersonaFor({ archetype: 'behavioral', difficulty: 3, voiceGender: 'female' }).id).toBe('priya');
    // Depth: diaz (2, male), kai (3, male), voss (3, female).
    expect(basePersonaFor({ archetype: 'depth', difficulty: 1, voiceGender: 'female' }).id).toBe('voss');
  });

  it('among personas with that voice, picks the closest difficulty', () => {
    expect(basePersonaFor({ archetype: 'behavioral', difficulty: 3, voiceGender: 'male' }).id).toBe('bishop');
    expect(basePersonaFor({ archetype: 'behavioral', difficulty: 2, voiceGender: 'male' }).id).toBe('osei');
    expect(basePersonaFor({ archetype: 'warmup', difficulty: 1, voiceGender: 'female' }).id).toBe('maya');
    expect(basePersonaFor({ archetype: 'warmup', difficulty: 3, voiceGender: 'female' }).id).toBe('june');
  });

  it('without a voice, or with one the archetype lacks, the closest difficulty wins (default 2)', () => {
    expect(basePersonaFor({ archetype: 'potential', difficulty: 3 }).id).toBe('okonkwo');
    expect(basePersonaFor({ archetype: 'depth' }).id).toBe('diaz');
    // No male warm-up persona exists: the archetype is kept, the voice is not.
    const warm = basePersonaFor({ archetype: 'warmup', difficulty: 3, voiceGender: 'male' });
    expect(warm).toMatchObject({ id: 'june', archetype: 'warmup', voiceGender: 'female' });
  });
});

describe('markets', () => {
  it('marketForCountry maps ISO codes (any case, padded) to their playbook', () => {
    expect(marketForCountry('JP')).toBe('jp');
    expect(marketForCountry('gb')).toBe('uk');
    expect(marketForCountry(' de ')).toBe('de');
    expect(marketForCountry('TW')).toBe('tw');
    expect(marketForCountry('CN')).toBe('cn');
    expect(marketForCountry('HK')).toBe('sea');
    expect(marketForCountry('MX')).toBe('es');
    expect(marketForCountry('PT')).toBe('br');
    expect(marketForCountry('CA')).toBe('us');
    for (const none of ['ZZ', '', '   ', null, undefined]) expect(marketForCountry(none)).toBeNull();
  });

  it('every country a playbook lists maps back to it (no country is claimed twice)', () => {
    for (const key of INTERVIEW_MARKET_KEYS) {
      for (const country of MARKET_NORMS[key].countries) expect(marketForCountry(country), `${key}/${country}`).toBe(key);
    }
  });

  it('resolveMarketNorms: the job country wins over the brand market and the language', () => {
    expect(resolveMarketNorms({ country: 'JP', brandMarket: 'cn', language: 'zh' }).key).toBe('jp');
    expect(resolveMarketNorms({ country: 'de', brandMarket: 'intl', language: 'en' }).key).toBe('de');
  });

  it('resolveMarketNorms: without a known country, GoApply is mainland China whatever the language', () => {
    expect(resolveMarketNorms({ country: null, brandMarket: 'cn', language: 'en' }).key).toBe('cn');
    expect(resolveMarketNorms({ country: 'ZZ', brandMarket: 'cn', language: 'ja' }).key).toBe('cn');
  });

  it('resolveMarketNorms: otherwise the session language, then the United States', () => {
    expect(resolveMarketNorms({ brandMarket: 'intl', language: 'ko' }).key).toBe('kr');
    expect(resolveMarketNorms({ language: 'ja' }).key).toBe('jp');
    expect(resolveMarketNorms({ language: 'zh-TW' }).key).toBe('tw');
    expect(resolveMarketNorms({ language: 'zh' }).key).toBe('cn');
    expect(resolveMarketNorms({ language: 'pt-BR' }).key).toBe('br');
    expect(resolveMarketNorms({ language: 'de-AT' }).key).toBe('de');
    expect(resolveMarketNorms({ country: 'ZZ', language: 'xx' }).key).toBe('us');
    expect(resolveMarketNorms({}).key).toBe('us');
  });
});
