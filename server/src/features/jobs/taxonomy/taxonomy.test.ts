// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TAXONOMY_NODES,
  TAXONOMY_SOURCES,
  TAXONOMY_VERSION,
  expandTaxonomyIds,
  getTaxonomyNode,
  taxonomyAncestors,
  taxonomyCategories,
  taxonomyLabel,
  taxonomyNodeLabel,
  taxonomyRolesUnder,
  validateTaxonomy,
  type TaxonomyNode,
} from './taxonomy.js';
import { normalizeTitle } from './match.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');

describe('taxonomy v1 structure', () => {
  it('is valid: unique snake_case ids, labels in both languages, proper parents, no empty branches', () => {
    expect(validateTaxonomy({ version: 1, asOf: '', sources: [], nodes: [...TAXONOMY_NODES] })).toEqual([]);
    expect(TAXONOMY_VERSION).toBe(1);
  });

  it('has about twenty Explore categories with groups and roles under each', () => {
    const l1 = taxonomyCategories();
    expect(l1.length).toBeGreaterThanOrEqual(18);
    expect(l1.length).toBeLessThanOrEqual(24);
    for (const c of l1) expect(taxonomyRolesUnder(c.id).length, c.id).toBeGreaterThanOrEqual(3);
    expect(TAXONOMY_NODES.filter((n) => n.level === 3).length).toBeGreaterThanOrEqual(150);
  });

  it('gives every role a parent group, a Chinese label and at least one synonym', () => {
    for (const n of TAXONOMY_NODES.filter((x) => x.level === 3)) {
      expect(getTaxonomyNode(n.parent!)?.level, n.id).toBe(2);
      expect(n.zh.trim(), n.id).not.toBe('');
      expect(n.synonyms.en.length + n.synonyms.zh.length, n.id).toBeGreaterThan(0);
    }
  });

  it('maps every normalized label and synonym to exactly one node', () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const n of TAXONOMY_NODES) {
      const phrases = new Set([n.en, n.zh, ...n.synonyms.en, ...n.synonyms.zh].map(normalizeTitle));
      for (const p of phrases) {
        const prev = owner.get(p);
        if (prev && prev !== n.id) collisions.push(`"${p}": ${prev} / ${n.id}`);
        owner.set(p, n.id);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('writes Chinese labels in Simplified characters (GoApply)', () => {
    const traditionalOnly = /[體專業開發據學機軟術務師員經經營銷財會計審數據庫測試網絡設計檢驗護醫藥療廠產質運輸廣編輯]/;
    const offenders = TAXONOMY_NODES.flatMap((n) => [n.zh, ...n.synonyms.zh]).filter((s) => traditionalOnly.test(s));
    expect(offenders).toEqual([]);
  });

  it('cites public sources and uses well-formed SOC codes', () => {
    expect(TAXONOMY_SOURCES.map((s) => s.id)).toContain('onet_soc_2019');
    const withSoc = TAXONOMY_NODES.filter((n) => n.soc?.length);
    expect(withSoc.length).toBeGreaterThan(80);
  });
});

describe('navigation helpers', () => {
  it('walks ancestors and expands ids at any level to roles', () => {
    expect(taxonomyAncestors('backend_engineer').map((n) => n.id)).toEqual(['backend_engineer', 'swe_backend', 'software_engineering']);
    const roles = expandTaxonomyIds(['swe_quality', 'backend_engineer', 'nope', 'qa_engineer']);
    expect(roles).toEqual(['qa_engineer', 'sdet', 'backend_engineer']);
    expect(expandTaxonomyIds(['data_ai']).length).toBe(taxonomyRolesUnder('data_ai').length);
  });

  it('labels per locale: zh is Simplified, zh-TW and others fall back to English', () => {
    expect(taxonomyLabel('product_manager', 'en')).toBe('Product manager');
    expect(taxonomyLabel('product_manager', 'zh')).toBe('产品经理');
    expect(taxonomyLabel('product_manager', 'zh-TW')).toBe('Product manager');
    expect(taxonomyLabel('product_manager', 'ja')).toBe('Product manager');
    expect(taxonomyLabel('missing', 'en')).toBeNull();
  });

  it('MKT-1C / JT-4: zh-TW shows a node\'s Traditional Chinese label when it has one, else English, never Simplified', () => {
    // SYNTHETIC node: the zhHant data arrives with MKT-3E (generated, reviewed by a Taiwan-native reader).
    const withHant: TaxonomyNode = { id: 'fixture_role', level: 3, parent: 'fixture_group', en: 'Software engineer', zh: '软件工程师', zhHant: '軟體工程師', synonyms: { en: [], zh: [], zhHant: ['軟體開發工程師'] } };
    const without: TaxonomyNode = { id: 'fixture_role_2', level: 3, parent: 'fixture_group', en: 'Data analyst', zh: '数据分析师', synonyms: { en: [], zh: [] } };
    expect(taxonomyNodeLabel(withHant, 'zh-TW')).toBe('軟體工程師');
    expect(taxonomyNodeLabel(withHant, 'zh')).toBe('软件工程师');
    expect(taxonomyNodeLabel(withHant, 'en')).toBe('Software engineer');
    expect(taxonomyNodeLabel(withHant, 'ja')).toBe('Software engineer');
    expect(taxonomyNodeLabel(without, 'zh-TW')).toBe('Data analyst');
    expect(taxonomyNodeLabel({ ...without, zhHant: '  ' }, 'zh-TW')).toBe('Data analyst');
    // Every id of the data as it is: zh-TW is the zhHant label when the node has one, else the English label.
    for (const n of TAXONOMY_NODES) expect(taxonomyLabel(n.id, 'zh-TW'), n.id).toBe(n.zhHant?.trim() || n.en);
  });

  it('MKT-1C / JT-4: a zhHant label is optional, but never blank', () => {
    const base = { version: 1, asOf: '', sources: [] };
    const nodes = (role: Partial<TaxonomyNode>): TaxonomyNode[] => [
      { id: 'cat', level: 1, parent: null, en: 'Category', zh: '类别', synonyms: { en: [], zh: [] } },
      { id: 'grp', level: 2, parent: 'cat', en: 'Group', zh: '组', synonyms: { en: [], zh: [] } },
      { id: 'role', level: 3, parent: 'grp', en: 'Role', zh: '角色', synonyms: { en: [], zh: [] }, ...role },
    ];
    expect(validateTaxonomy({ ...base, nodes: nodes({}) })).toEqual([]);
    expect(validateTaxonomy({ ...base, nodes: nodes({ zhHant: '角色', synonyms: { en: [], zh: [], zhHant: ['職位'] } }) })).toEqual([]);
    expect(validateTaxonomy({ ...base, nodes: nodes({ zhHant: ' ' }) })).toEqual(['role has an empty Traditional Chinese label']);
  });
});

describe('i18n bundle', () => {
  it('has one English label per category and group, equal to the data', () => {
    // The `taxonomy` namespace of the English web bundle (WP-91 merged it out of i18n/staging/taxonomy.en.json).
    const english = JSON.parse(readFileSync(path.join(repoRoot, 'i18n/messages/en.json'), 'utf8')) as {
      taxonomy: { categories: Record<string, string>; groups: Record<string, string> };
    };
    const bundle = { taxonomy: english.taxonomy };
    expect(Object.keys(bundle.taxonomy).sort()).toEqual(['categories', 'groups']);
    const l1 = Object.fromEntries(TAXONOMY_NODES.filter((n) => n.level === 1).map((n) => [n.id, n.en]));
    const l2 = Object.fromEntries(TAXONOMY_NODES.filter((n) => n.level === 2).map((n) => [n.id, n.en]));
    expect(bundle.taxonomy.categories).toEqual(l1);
    expect(bundle.taxonomy.groups).toEqual(l2);
    const text = JSON.stringify(bundle);
    expect(text).not.toMatch(/RoboApply|GoApply|\bunlimited\b|\bats\b|\bjd\b/i);
  });
});
