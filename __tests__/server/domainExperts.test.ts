// __tests__/server/domainExperts.test.ts
//
// Domain-expert catalog + classifier (server/src/interview-engine/catalog/
// domainExperts.ts). The catalog is the third orthogonal directive dimension
// of the interview engine (archetype × format × domain); these tests pin
// (1) the playbook shape every domain must satisfy, (2) the deterministic
// role/JD classifier on a representative title per domain, and (3) the
// no-lens fallback for generic titles — a wrong domain lens is worse than
// none, so under-classification is the contract.
//
// domainExperts.ts is deliberately dependency-free, which is what makes it
// importable here without the server's nodenext .js-specifier resolution.

import { describe, expect, it } from 'vitest';
import {
  DOMAIN_EXPERTS,
  INTERVIEW_DOMAINS,
  classifyDomain,
  getDomainCatalog,
  getDomainExpert,
  resolveDomainExpert,
} from '../../server/src/interview-engine/catalog/domainExperts';

describe('domain expert playbooks', () => {
  it('covers all 18 domains with complete playbooks', () => {
    expect(INTERVIEW_DOMAINS).toHaveLength(18);
    for (const key of INTERVIEW_DOMAINS) {
      const p = DOMAIN_EXPERTS[key];
      expect(p.key).toBe(key);
      expect(p.labelEn.length).toBeGreaterThan(2);
      expect(p.summary.length).toBeGreaterThan(20);
      // Directives must be substantive single paragraphs (they are injected
      // into prompts — a newline in voiceDirective would read as a new
      // prompt block, and a short directive means the author call failed).
      expect(p.blueprintDirective.length).toBeGreaterThan(400);
      expect(p.voiceDirective.length).toBeGreaterThan(250);
      expect(p.evaluationLens.length).toBeGreaterThan(250);
      expect(p.voiceDirective).not.toMatch(/\n/);
      expect(p.blueprintDirective).not.toMatch(/\n/);
      expect(p.evaluationLens).not.toMatch(/\n/);
      expect(p.matchTerms.length).toBeGreaterThanOrEqual(15);
      expect(p.deepDiveTopics.length).toBeGreaterThanOrEqual(6);
      // Classifier terms are matched against lowercased text.
      for (const t of p.matchTerms) expect(t).toBe(t.toLowerCase());
    }
  });

  it('keeps matchTerms domain-exclusive (a shared term would make ties author-order-dependent)', () => {
    const seen = new Map<string, string>();
    for (const key of INTERVIEW_DOMAINS) {
      for (const t of DOMAIN_EXPERTS[key].matchTerms) {
        expect(seen.has(t), `term "${t}" in both ${seen.get(t)} and ${key}`).toBe(false);
        seen.set(t, key);
      }
    }
  });
});

describe('classifyDomain', () => {
  const cases: Array<[string, string]> = [
    ['Backend Engineer', 'software'],
    ['Site Reliability Engineer', 'software'],
    ['Machine Learning Engineer', 'ai-ml'],
    ['Data Engineer', 'data'],
    ['Embedded Firmware Engineer', 'hardware'],
    ['ASIC Verification Engineer', 'hardware'],
    ['Product Manager', 'product'],
    ['UX Researcher', 'design'],
    ['Growth Marketing Manager', 'marketing'],
    ['Video Producer', 'media'],
    ['Account Executive', 'sales'],
    ['Investment Banking Analyst', 'finance'],
    ['Staff Accountant', 'accounting'],
    ['Audit Senior', 'accounting'],
    ['Corporate Counsel', 'legal'],
    ['Senior Litigation Associate', 'legal'],
    ['Underwriter', 'insurance'],
    ['Actuarial Analyst', 'insurance'],
    ['Registered Nurse', 'healthcare'],
    ['Category Manager', 'consumer'],
    ['Supply Chain Planner', 'operations'],
    ['HR Business Partner', 'hr'],
    ['High School Math Teacher', 'education'],
  ];

  it.each(cases)('classifies "%s" as %s', (role, want) => {
    expect(classifyDomain(role)?.key).toBe(want);
  });

  it('returns null for generic titles rather than guessing', () => {
    expect(classifyDomain('Office Administrator')).toBeNull();
    expect(classifyDomain('Founder')).toBeNull();
    expect(classifyDomain('')).toBeNull();
    expect(classifyDomain(undefined)).toBeNull();
  });

  it('classifies from JD text when the role title is empty', () => {
    const jd =
      'We seek a paralegal to support our litigation team with discovery, depositions and privilege review.';
    expect(classifyDomain('', jd)?.key).toBe('legal');
  });

  it('weights the role title over a noisy JD', () => {
    // A legal JD mentioning software tooling must still classify legal when
    // the TITLE is the legal one — role hits weigh 3× a JD hit.
    const jd = 'Our legal team uses react dashboards and kubernetes-hosted tools daily.';
    expect(classifyDomain('Corporate Counsel', jd)?.key).toBe('legal');
  });

  it('matches single-word terms on token boundaries only', () => {
    // 'sre' must not fire inside an unrelated word.
    expect(classifyDomain('Presrely Coordinator')).toBeNull();
  });
});

describe('resolveDomainExpert', () => {
  it('lets an explicit key override classification', () => {
    expect(resolveDomainExpert('legal', 'Backend Engineer')?.key).toBe('legal');
  });

  it('falls back to classification when the key is unknown', () => {
    expect(resolveDomainExpert('not-a-domain', 'Backend Engineer')?.key).toBe('software');
  });

  it('getDomainExpert rejects unknown keys', () => {
    expect(getDomainExpert('nope')).toBeNull();
    expect(getDomainExpert(null)).toBeNull();
  });
});

describe('getDomainCatalog', () => {
  it('returns the light projection without directives', () => {
    const cat = getDomainCatalog();
    expect(cat).toHaveLength(18);
    for (const row of cat) {
      expect(row).toEqual({
        key: expect.any(String),
        labelEn: expect.any(String),
        summary: expect.any(String),
        deepDiveTopics: expect.any(Array),
      });
    }
  });
});
