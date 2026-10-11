// @vitest-environment node
// The content hash a fit depends on (MARKET_STRATEGY 2.2): the same posting gives the same hash however it is
// spaced, cased or ordered; a changed requirement gives another.
import { describe, expect, it } from 'vitest';

import { JOB_HASH_DESCRIPTION_CHARS, JOB_HASH_DESCRIPTION_READ_CHARS, currentJobHash, jobContentHash, requirementTextOf, storedJobHash } from './jobHash.js';
import { jobRecord } from './testkit.js';

const BASE = {
  title: 'Senior Backend Engineer',
  qualifications: '5+ years of backend experience.\nKubernetes required.',
  descriptionPlain: 'Build APIs in TypeScript and Go.',
  skills: ['typescript', 'go', 'kubernetes'],
};

describe('jobContentHash', () => {
  it('is a sha1 hex digest, the same for the same content', () => {
    expect(jobContentHash(BASE)).toMatch(/^[0-9a-f]{40}$/);
    expect(jobContentHash({ ...BASE })).toBe(jobContentHash(BASE));
  });

  it('is stable under whitespace, letter case, width forms and skill order', () => {
    const h = jobContentHash(BASE);
    expect(jobContentHash({ ...BASE, title: '  senior   BACKEND engineer ' })).toBe(h);
    expect(jobContentHash({ ...BASE, qualifications: '5+ years of backend experience.   Kubernetes   required.\n\n' })).toBe(h);
    expect(jobContentHash({ ...BASE, skills: ['kubernetes', 'Go', ' TypeScript ', 'go'] })).toBe(h);
    // Full-width letters and digits (NFKC) are the same text.
    expect(jobContentHash({ ...BASE, title: 'Ｓenior Backend Engineer' })).toBe(h);
    // A skill list that is missing counts as an empty one.
    expect(jobContentHash({ ...BASE, skills: null })).toBe(jobContentHash({ ...BASE, skills: [] }));
  });

  it('changes when the title, a requirement line or a skill changes', () => {
    const h = jobContentHash(BASE);
    expect(jobContentHash({ ...BASE, title: 'Staff Backend Engineer' })).not.toBe(h);
    expect(jobContentHash({ ...BASE, qualifications: '7+ years of backend experience.\nKubernetes required.' })).not.toBe(h);
    expect(jobContentHash({ ...BASE, qualifications: `${BASE.qualifications}\nMust hold a security clearance.` })).not.toBe(h);
    expect(jobContentHash({ ...BASE, skills: ['typescript', 'go'] })).not.toBe(h);
    expect(jobContentHash({ ...BASE, skills: ['typescript', 'go', 'kubernetes', 'rust'] })).not.toBe(h);
  });

  it('reads the qualifications when the posting has them, else the head of the plain description', () => {
    // With qualifications the description is not part of the hash.
    expect(jobContentHash({ ...BASE, descriptionPlain: 'A rewritten company blurb.' })).toBe(jobContentHash(BASE));
    // Without them the first 4,000 characters of the description are.
    const noQual = { ...BASE, qualifications: null };
    expect(requirementTextOf(noQual)).toBe('build apis in typescript and go.');
    expect(jobContentHash({ ...noQual, descriptionPlain: 'Build APIs in Rust.' })).not.toBe(jobContentHash(noQual));
    const long = 'x'.repeat(JOB_HASH_DESCRIPTION_CHARS);
    expect(jobContentHash({ ...noQual, descriptionPlain: `${long} a later edit` })).toBe(jobContentHash({ ...noQual, descriptionPlain: `${long} another ending` }));
    expect(jobContentHash({ ...noQual, descriptionPlain: `y${long}` })).not.toBe(jobContentHash({ ...noQual, descriptionPlain: long }));
    // Blank qualifications are no qualifications.
    expect(jobContentHash({ ...BASE, qualifications: '   ' })).toBe(jobContentHash(noQual));
  });

  it('only the head of a long description is read: it is cut before it is normalised, so a fetched head hashes like the full row', () => {
    const noQual = { ...BASE, qualifications: null };
    // Mixed text with wide forms, runs of spaces and characters outside the BMP, far longer than the head.
    const long = Array.from({ length: 4000 }, (_, i) => (i % 7 === 0 ? 'Ｋubernetes   工程師 \u{1F680}\n\n' : `requirement ${i}  `)).join('');
    expect(long.length).toBeGreaterThan(JOB_HASH_DESCRIPTION_READ_CHARS * 3);
    const full = jobContentHash({ ...noQual, descriptionPlain: long });
    // Nothing past the head can change the hash.
    expect(jobContentHash({ ...noQual, descriptionPlain: `${long.slice(0, JOB_HASH_DESCRIPTION_READ_CHARS)} a completely different ending` })).toBe(full);
    // What `left("descriptionPlain", 8000)` returns: the first 8,000 characters counted as code points (at least the
    // first 8,000 UTF-16 units). The hash of that head is the hash of the full row.
    const sqlLeft = Array.from(long).slice(0, JOB_HASH_DESCRIPTION_READ_CHARS).join('');
    expect(sqlLeft.length).toBeGreaterThanOrEqual(JOB_HASH_DESCRIPTION_READ_CHARS);
    expect(jobContentHash({ ...noQual, descriptionPlain: sqlLeft })).toBe(full);
    // The normalised text is still cut to 4,000 characters.
    expect(requirementTextOf({ ...noQual, descriptionPlain: long })).toHaveLength(JOB_HASH_DESCRIPTION_CHARS);
    // A change inside the head does change it.
    expect(jobContentHash({ ...noQual, descriptionPlain: `Rust required. ${long}` })).not.toBe(full);
  });

  it('pay, location, dates and the company are not part of it', () => {
    const a = jobRecord();
    const b = jobRecord({ companyName: 'Other Co', location: 'Munich, DE', locationCity: 'Munich', salaryAnnualMin: 1, salaryAnnualMax: 2, seniority: 'mid', benefits: 'Gym', responsibilities: 'Own things' });
    expect(jobContentHash(b)).toBe(jobContentHash(a));
  });

  it('currentJobHash: the stored hash of the row when it has one, else computed from the row', () => {
    const row = jobRecord();
    expect(currentJobHash(row)).toBe(jobContentHash(row));
    expect(currentJobHash({ ...row, contentHash: null })).toBe(jobContentHash(row));
    expect(currentJobHash({ ...row, contentHash: 'stored-with-the-search-document' })).toBe('stored-with-the-search-document');
  });

  it('storedJobHash: only the stored hash, never a computed one (a list row carries no text to compute from)', () => {
    expect(storedJobHash(jobRecord())).toBeNull();
    expect(storedJobHash({ contentHash: '' })).toBeNull();
    expect(storedJobHash({ contentHash: 'stored-with-the-search-document' })).toBe('stored-with-the-search-document');
  });
});
