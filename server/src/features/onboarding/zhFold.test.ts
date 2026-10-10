// @vitest-environment node
//
// Verification finding: the job-title typeahead found nothing for Chinese
// typed in Traditional characters (zh-TW): GET /onboarding/title-suggest
// ?q=後端 → items []. The taxonomy's Chinese phrases are Simplified.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { TAXONOMY_NODES } from '../jobs/taxonomy/index.js';
import { suggestTitles } from './defaults.js';
import { foldToSimplified, hasHan } from './zhFold.js';

describe('foldToSimplified', () => {
  it('leaves Latin text and Simplified text alone', () => {
    expect(foldToSimplified('backend')).toBe('backend');
    expect(foldToSimplified('后端工程师')).toBe('后端工程师');
    expect(hasHan('backend')).toBe(false);
    expect(hasHan('後端')).toBe(true);
  });

  it('reads Traditional characters as Simplified', () => {
    expect(foldToSimplified('後端')).toBe('后端');
    expect(foldToSimplified('產品經理')).toBe('产品经理');
    expect(foldToSimplified('數據分析師')).toBe('数据分析师');
    expect(foldToSimplified('會計')).toBe('会计');
    expect(foldToSimplified('設計師')).toBe('设计师');
  });

  it('reads Taiwan wording as the mainland word the taxonomy uses', () => {
    expect(foldToSimplified('軟體工程師')).toBe('软件工程师');
    expect(foldToSimplified('資料科學家')).toBe('数据科学家');
    expect(foldToSimplified('行銷')).toBe('营销');
    expect(foldToSimplified('專案經理')).toBe('项目经理');
  });

  it('every pair maps one character to one character that the taxonomy phrases use', () => {
    const used = new Set<string>();
    for (const n of TAXONOMY_NODES) for (const s of [n.zh, ...n.synonyms.zh]) for (const ch of s) used.add(ch);
    // Each Simplified phrase of the taxonomy is its own reading (the fold never damages Simplified input).
    for (const n of TAXONOMY_NODES) for (const s of [n.zh, ...n.synonyms.zh]) expect(foldToSimplified(s), s).toBe(s);
    for (const [trad, simp] of [['後', '后'], ['師', '师'], ['軟', '软'], ['銷', '销'], ['驗', '验']]) {
      expect(foldToSimplified(trad!)).toBe(simp);
      expect(used.has(simp!), simp).toBe(true);
    }
  });
});

describe('title typeahead with Traditional Chinese input', () => {
  const ids = (q: string, locale = 'zh-TW') => suggestTitles(q, locale).map((s) => s.taxonomyId);

  it('"後端" finds the backend roles (it found nothing)', () => {
    expect(ids('后端', 'zh')).toContain('backend_engineer');
    expect(ids('後端')).toContain('backend_engineer');
    expect(ids('後端')).toEqual(ids('后端', 'zh-TW'));
  });

  it('Taiwan wording finds the role too', () => {
    expect(ids('產品經理').length).toBeGreaterThan(0);
    expect(ids('產品經理')).toEqual(ids('产品经理', 'zh-TW'));
    expect(ids('軟體工程師')).toEqual(ids('软件工程师', 'zh-TW'));
    expect(ids('軟體工程師').length).toBeGreaterThan(0);
  });

  it('English input is unchanged, and at most ten titles come back', () => {
    expect(ids('backend', 'en')).toContain('backend_engineer');
    expect(suggestTitles('工程師', 'zh-TW').length).toBeLessThanOrEqual(10);
    expect(suggestTitles('zzzz', 'en')).toEqual([]);
  });

  it('carries the ids behind the context so the web can localize it', () => {
    const role = suggestTitles('backend engineer', 'ja').find((s) => s.taxonomyId === 'backend_engineer')!;
    expect(role.contextIds).toEqual(['swe_backend', 'software_engineering']);
    const category = suggestTitles('software engineering', 'ja').find((s) => s.taxonomyId === 'software_engineering')!;
    expect(category.contextIds).toEqual([]);
    expect(category.children.length).toBeGreaterThan(0);
  });
});
