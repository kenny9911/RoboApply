// WP-66 — the cn AI-interview format is registered for market `cn` only; the
// RoboApply (intl) formats and the engine catalog are unchanged (regression).

import { describe, expect, it } from 'vitest';

import {
  INTERVIEW_FORMATS,
  MARKET_FORMATS,
  formatsAsTypes,
  formatsForMarket,
  getFormat,
} from '../../../../interview-engine/catalog/interviewFormats.js';
import { INTERVIEW_TYPES, findType, getCatalog } from '../../../../interview-engine/catalog/interviewCatalog.js';
import { CN_AI_INTERVIEW_FORMAT_ID, CN_FORMAT_BLUEPRINT_DIRECTIVE } from '../index.js';

/** The 28 researched intl formats, in order, before WP-66. */
const INTL_IDS = [
  'screening', 'behavioral', 'technical', 'system', 'case', 'culture', 'panel', 'take_home', 'debugging',
  'incident_sre', 'sql_analytics', 'product_sense', 'portfolio', 'design_critique', 'research_design',
  'sales_roleplay', 'pitch_demo', 'account_strategy', 'modeling_test', 'finance_technical', 'clinical_scenario',
  'situational_judgement', 'practical_skills', 'teaching_demo', 'ops_case', 'presentation', 'leadership_strategy',
  'reference_check',
];

describe('RoboApply formats unchanged', () => {
  it('the intl list is the same 28 formats in the same order', () => {
    expect(INTERVIEW_FORMATS.map((f) => f.id)).toEqual(INTL_IDS);
    expect(formatsAsTypes().map((t) => t.id)).toEqual(INTL_IDS);
    expect(formatsAsTypes('intl')).toEqual(formatsAsTypes());
    expect(formatsForMarket()).toBe(INTERVIEW_FORMATS);
  });

  it('the engine catalog does not list the cn format', () => {
    expect(INTERVIEW_TYPES.map((t) => t.id)).toEqual(INTL_IDS);
    expect(findType(CN_AI_INTERVIEW_FORMAT_ID)).toBeUndefined();
    expect(getCatalog().types.map((t) => t.id)).not.toContain(CN_AI_INTERVIEW_FORMAT_ID);
  });

  it('no intl format carries a market scope, and the projection never leaks a directive', () => {
    for (const f of INTERVIEW_FORMATS) expect(f.markets, f.id).toBeUndefined();
    for (const t of formatsAsTypes('cn')) expect(Object.keys(t).sort()).toEqual(['id', 'label', 'minutes', 'sub', 'suitedRoleCategories']);
  });
});

describe('the cn format', () => {
  it('is registered for market cn, listed first there, and resolvable by id', () => {
    expect(MARKET_FORMATS.map((f) => f.id)).toEqual([CN_AI_INTERVIEW_FORMAT_ID]);
    const cn = formatsAsTypes('cn');
    expect(cn[0]).toMatchObject({ id: CN_AI_INTERVIEW_FORMAT_ID, minutes: 25 });
    expect(cn.slice(1).map((t) => t.id)).toEqual(INTL_IDS);
    expect(getFormat(CN_AI_INTERVIEW_FORMAT_ID)?.blueprintDirective).toBe(CN_FORMAT_BLUEPRINT_DIRECTIVE);
    expect(getFormat(CN_AI_INTERVIEW_FORMAT_ID)?.markets).toEqual(['cn']);
  });

  it('names no vendor in its labels', () => {
    const f = getFormat(CN_AI_INTERVIEW_FORMAT_ID)!;
    expect(`${f.labelEn} ${f.subEn}`).not.toMatch(/北森|牛客|HireVue|Beisen/);
  });
});
