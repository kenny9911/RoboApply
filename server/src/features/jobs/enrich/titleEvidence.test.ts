// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bestTaxonomyMatch, matchTitle } from '../taxonomy/index.js';
import { heldByRetiredWord, roleFromTitle, titleEvidence, titleIsDecisive, titleMatches, titleReadings } from './titleEvidence.js';

describe('title evidence (SM-2)', () => {
  it('a title without Traditional characters has one reading and is matched as the taxonomy matches it', () => {
    for (const title of ['Java Backend Architect', 'Senior Backend Engineer', '高级前端开发工程师', 'Wizard of Light Bulb Moments', '']) {
      expect(titleReadings(title)).toEqual([title]);
      expect(titleMatches(title, { limit: 5, minScore: 0.4 })).toEqual(matchTitle(title, { limit: 5, minScore: 0.4 }));
      expect(titleEvidence(title)).toEqual(bestTaxonomyMatch(title));
    }
  });

  it('a Taiwan title is also read in its mainland form, for matching only', () => {
    expect(titleReadings('資深後端工程師')).toEqual(['資深後端工程師', '资深后端工程师']);
    // The taxonomy alone finds nothing in the Traditional text.
    expect(bestTaxonomyMatch('資深後端工程師')).toBeNull();
    expect(titleEvidence('資深後端工程師')).toMatchObject({ id: 'backend_engineer', score: 1 });
    expect(titleEvidence('資料分析師')).toMatchObject({ id: 'data_analyst', score: 1 });
    expect(titleEvidence('專案經理')).toMatchObject({ id: 'project_manager', score: 1 });
    expect(titleEvidence('Senior Backend Engineer 資深後端工程師')?.id).toBe('backend_engineer');
    expect(titleEvidence('儲備幹部')).toBeNull();
  });

  it('takes the better of the two readings, not the first that matches', () => {
    // As written only the shared characters 前端 match (0.7); the mainland reading is the role by name.
    expect(bestTaxonomyMatch('前端工程師')).toMatchObject({ id: 'frontend_engineer', score: 0.7 });
    expect(titleEvidence('前端工程師')).toMatchObject({ id: 'frontend_engineer', score: 1 });
    const ranked = titleMatches('前端工程師', { limit: 3, minScore: 0.4 });
    expect(ranked[0]).toMatchObject({ id: 'frontend_engineer', score: 1 });
    expect(new Set(ranked.map((m) => m.id)).size).toBe(ranked.length);
    expect(titleMatches('資深後端工程師', { limit: 1 })).toHaveLength(1);
  });

  it('a match of 0.9 or more decides the role; anything weaker, or no match, does not', () => {
    expect(titleIsDecisive(titleEvidence('Backend Engineer'))).toBe(true);
    expect(titleIsDecisive(titleEvidence('Senior Architect'))).toBe(true);
    expect(titleIsDecisive(titleEvidence('資深後端工程師'))).toBe(true);
    expect(titleIsDecisive({ score: 0.9 })).toBe(true);
    expect(titleIsDecisive({ score: 0.899 })).toBe(false);
    // The catch-all role by name (0.85), a role chosen by its modifiers (0.85), a partial phrase and no match.
    for (const title of ['Software Engineer', 'Java Backend Architect', 'Registered Nurse - ICU', 'Head of Special Projects']) expect(titleIsDecisive(titleEvidence(title)), title).toBe(false);
    expect(titleIsDecisive(null)).toBe(false);
  });

  it('tells a role stored by the retired one-word match from any other', () => {
    // The word that used to file the title is in it, and nothing in the title supports the role today.
    expect(heldByRetiredWord('Java Backend Architect', 'architect')).toBe(true);
    expect(heldByRetiredWord('Principal Engineer', 'education_administrator')).toBe(true);
    expect(heldByRetiredWord('SQL Server Developer', 'server')).toBe(true);
    expect(heldByRetiredWord('Sales Developer', 'software_engineer')).toBe(true);
    expect(heldByRetiredWord('光学研发工程师', 'software_engineer')).toBe(true);
    // The word is the title: the role by name.
    expect(heldByRetiredWord('Senior Architect', 'architect')).toBe(false);
    expect(heldByRetiredWord('Principal', 'education_administrator')).toBe(false);
    // The title supports the role some other way (building words; a longer phrase).
    expect(heldByRetiredWord('Landscape Architect', 'architect')).toBe(false);
    expect(heldByRetiredWord('Architect, Residential Projects', 'architect')).toBe(false);
    expect(heldByRetiredWord('School Principal', 'education_administrator')).toBe(false);
    // Another role, no role, or a role no word of the title ever named (a model chose it).
    expect(heldByRetiredWord('Java Backend Architect', 'software_architect')).toBe(false);
    expect(heldByRetiredWord('Java Backend Architect', 'backend_engineer')).toBe(false);
    expect(heldByRetiredWord('Java Backend Architect', null)).toBe(false);
    expect(heldByRetiredWord('Registered Nurse - ICU', 'nurse_practitioner')).toBe(false);
    // 开发工程师 still says "software" inside a longer title: a stored software role beside it stays.
    for (const title of ['系统开发工程师', '中间件开发工程师', 'ERP开发工程师', '音视频开发工程师', '爬虫开发工程师']) {
      expect(heldByRetiredWord(title, 'software_engineer'), title).toBe(false);
      expect(roleFromTitle(title, 'software_engineer'), title).toMatchObject({ decisive: false, role: undefined, det: { id: 'software_engineer' } });
    }
    // Words that only became whole-title names with SM-2 never filed a longer title, so a role a
    // model chose beside one of them is not a leftover of the retired rule.
    expect(heldByRetiredWord('新媒体设计', 'social_media_manager')).toBe(false);
    expect(heldByRetiredWord('行政总厨', 'administrative_assistant')).toBe(false);
    expect(heldByRetiredWord('物流运营专员', 'product_operations')).toBe(false);
    expect(roleFromTitle('新媒体设计', 'social_media_manager').role).toBeUndefined();
  });

  it('roleFromTitle: the one ruling enrichment and the backfill share', () => {
    // Decisive: the title names the role, whatever the row holds.
    expect(roleFromTitle('Microservices Architect', 'architect')).toMatchObject({ decisive: true, role: 'software_architect' });
    expect(roleFromTitle('Backend Engineer', null)).toMatchObject({ decisive: true, role: 'backend_engineer' });
    // Retired one-word match: today's weaker match, or no role at all.
    expect(roleFromTitle('Java Backend Architect', 'architect')).toMatchObject({ decisive: false, role: 'software_architect' });
    expect(roleFromTitle('Principal Engineer', 'education_administrator')).toMatchObject({ decisive: false, role: null, det: null });
    // Otherwise the title does not rule: the row keeps its role unless a model picks another.
    expect(roleFromTitle('Registered Nurse - ICU', 'nurse_practitioner')).toMatchObject({ decisive: false, role: undefined });
    expect(roleFromTitle('Java Backend Architect', null).role).toBeUndefined();
    expect(roleFromTitle('Head of Special Projects', 'strategy_manager')).toMatchObject({ decisive: false, role: undefined, det: null });
  });
});
