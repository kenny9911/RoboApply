// @vitest-environment node
//
// The lexical document and the embedded card text of a posting (MKT-2H items 2 and 3).

import { describe, expect, it } from 'vitest';
import { CARD_TEXT_MAX_CHARS, buildCardText, cardHash } from './cardText.js';
import { REQUIREMENTS_HEAD_CHARS, jobTextParts, type SkillLabels } from './jobText.js';
import { SEARCH_DOC_MAX_CHARS, buildSearchDoc } from './searchDoc.js';
import { segmentForSearch } from './segment.js';
import { indexJob } from './testkit.js';

describe('buildSearchDoc', () => {
  it('holds the title tokens, both role labels and the required skills, in the documented order', () => {
    const doc = buildSearchDoc(indexJob());
    const tokens = doc.split(' ');
    for (const t of ['senior', 'backend', 'engineer']) expect(tokens).toContain(t);
    // Role labels of backend_engineer: "Backend engineer" and 后端开发工程师 (segmented).
    for (const t of segmentForSearch('后端开发工程师')) expect(tokens).toContain(t);
    for (const t of ['go', 'postgresql', 'kubernetes']) expect(tokens).toContain(t);
    // Order: title, role labels, level, required skills, preferred skills, summary, requirements.
    const at = (t: string) => tokens.indexOf(t);
    expect(tokens.slice(0, 3)).toEqual(['senior', 'backend', 'engineer']);
    expect(at('go')).toBeLessThan(at('kubernetes'));
    expect(at('postgresql')).toBeLessThan(at('kubernetes'));
    expect(at('kubernetes')).toBeLessThan(at('fintech'));
    expect(at('fintech')).toBeLessThan(at('distributed'));
  });

  it('leaves soft skills, benefits, company boilerplate and legal text out', () => {
    const doc = buildSearchDoc(indexJob());
    for (const t of ['communication', 'lunch', 'gym', 'vacation', 'friendly', 'equal', 'opportunity']) expect(doc.split(' ')).not.toContain(t);
  });

  it('reads the head of the description only when the posting has no qualifications section', () => {
    const noQual = indexJob({ qualifications: null, descriptionPlain: 'You will write Rust services. '.repeat(100) });
    expect(buildSearchDoc(noQual).split(' ')).toContain('rust');
    expect(jobTextParts(noQual).requirementsHead.length).toBe(REQUIREMENTS_HEAD_CHARS);
    expect(jobTextParts(indexJob({ qualifications: 'x'.repeat(5000) })).requirementsHead).toHaveLength(1200);
  });

  it('is at most 4,000 characters and ends on a whole token', () => {
    const long = indexJob({ qualifications: Array.from({ length: 400 }, (_, i) => `requirement${i}`).join(' '), summary: Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ') });
    const doc = buildSearchDoc(long);
    expect(doc.length).toBeLessThanOrEqual(SEARCH_DOC_MAX_CHARS);
    expect(SEARCH_DOC_MAX_CHARS).toBe(4000);
    expect(doc.endsWith(' ')).toBe(false);
    expect(doc.split(' ').at(-1)).toMatch(/^(word|requirement)\d+$/);
  });

  it('is a Simplified search copy of a Traditional posting, built with the query tokenizer', () => {
    const tw = indexJob({ title: '資深後端工程師', primaryTaxonomyId: null, seniority: null, skills: [], skillsDetail: null, summary: null, qualifications: '熟悉資料庫設計', descriptionPlain: null });
    const doc = buildSearchDoc(tw);
    expect(doc).not.toMatch(/[資後師庫設計]/);
    expect(doc.split(' ')).toEqual(expect.arrayContaining(segmentForSearch('数据库')));
  });

  it('uses the stored skill strings without a vocabulary, and canonical labels with their spellings when ids exist', () => {
    const labels: SkillLabels = {
      kindOf: (id) => (id === 'sk_comm' ? 'soft' : 'hard'),
      label: (id, locale) => ({ sk_go: { en: 'Go', zh: 'Go 语言' }, sk_pg: { en: 'PostgreSQL', zh: 'PostgreSQL' }, sk_comm: { en: 'Communication', zh: '沟通能力' } })[id]?.[locale === 'zh' ? 'zh' : 'en'] ?? '',
    };
    const row = indexJob({ skillIds: ['sk_go', 'sk_pg', 'sk_comm'], skills: ['golang', 'Postgres'], skillsDetail: [{ skill: 'golang', required: true }, { skill: 'Postgres', required: true }] });
    // No vocabulary: ids are ignored and the posting's own strings are used.
    expect(jobTextParts(row).requiredSkills).toEqual(['golang', 'Postgres']);
    const parts = jobTextParts(row, { skillLabels: labels });
    expect(parts.requiredSkills).toEqual(['Go', 'Go 语言', 'PostgreSQL']);
    expect(parts.skillAliases).toEqual(['golang', 'Postgres']);
    const tokens = buildSearchDoc(row, { skillLabels: labels }).split(' ');
    for (const t of ['go', '语言', 'postgresql', 'golang', 'postgres']) expect(tokens).toContain(t);
    expect(tokens).not.toContain('communication');
    expect(tokens).not.toContain('沟通');
  });

  it('needs nothing but a title', () => {
    const bare = indexJob({ primaryTaxonomyId: null, seniority: null, skills: [], skillsDetail: null, summary: null, qualifications: null, descriptionPlain: null });
    expect(buildSearchDoc(bare)).toBe('senior backend engineer');
  });
});

describe('buildCardText', () => {
  it('is the title, the role labels, the level, required then preferred skills, the summary and the requirements head', () => {
    expect(buildCardText(indexJob()).split('\n')).toEqual([
      'Senior Backend Engineer',
      'Backend engineer / 后端开发工程师',
      'senior',
      'Go, PostgreSQL',
      'Kubernetes',
      'Build payment services for a growing fintech. Own the ledger and its APIs.',
      'Five years of backend work. Strong Go. Experience with relational databases and distributed systems.',
    ]);
  });

  it('holds no benefits or boilerplate, and is at most 2,000 characters', () => {
    const text = buildCardText(indexJob({ summary: 's'.repeat(3000) }));
    expect(text.length).toBeLessThanOrEqual(CARD_TEXT_MAX_CHARS);
    expect(buildCardText(indexJob())).not.toMatch(/lunch|gym|Equal opportunity/);
  });

  it('has a stable sha1 that moves with the text', () => {
    const a = cardHash(buildCardText(indexJob()));
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(cardHash(buildCardText(indexJob()))).toBe(a);
    expect(cardHash(buildCardText(indexJob({ summary: 'Another summary.' })))).not.toBe(a);
    // Benefits are not part of the card: changing them does not re-embed the job.
    expect(cardHash(buildCardText(indexJob({ descriptionPlain: 'Benefits: a different list.' })))).toBe(a);
  });
});
