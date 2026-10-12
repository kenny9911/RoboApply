import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GENERIC_ADAPTERS, GENERIC_SITES, applicationForm } from '../../src/adapters/intl/generic';
import { INTL_ADAPTERS, INTL_FILLABLE_ATS_TYPES } from '../../src/adapters/intl/index';
import type { AtsAdapter } from '../../src/adapters/types';
import { detectAdapter } from '../../src/content/detect';
import { INTL_FIXTURES, loadIntlFixture, runIntlFixtureCases } from './harness';

function site(name: string): AtsAdapter {
  const a = GENERIC_ADAPTERS.find((x) => x.siteName === name);
  if (!a) throw new Error(`no generic adapter for ${name}`);
  return a;
}

describe('generic adapter (label heuristics, requested hosts only)', () => {
  // One contract run per requested host, three saved forms in all.
  describe('Jobvite', () => {
    runIntlFixtureCasesOne(site('Jobvite'), 'jobvite', 'https://jobs.jobvite.com/exampleco/job/oAbC123/apply', {
      job: { title: 'Sales Engineer', company: 'Example Co', location: 'Chicago, Illinois' },
      fields: [
        { label: 'First Name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Phone', kind: 'tel', key: 'phone' },
        { label: 'LinkedIn Profile', kind: 'url', key: 'linkedin' },
        { label: 'How did you hear about us?', kind: 'select', key: null },
        { label: 'Resume', kind: 'file', key: 'resume', required: true },
        { label: 'Why do you want to join?', kind: 'textarea', key: null },
      ],
      roundTrip: [
        { label: 'LinkedIn Profile', value: 'https://www.linkedin.com/in/avery-example' },
        { label: 'How did you hear about us?', value: 'Referral' },
      ],
      resume: 'Resume',
    });
  });

  describe('BambooHR', () => {
    runIntlFixtureCasesOne(site('BambooHR'), 'bamboohr', 'https://samplelabs.bamboohr.com/careers/42', {
      job: { title: 'Office Coordinator', company: 'Sample Labs', location: 'Portland, Oregon' },
      fields: [
        { label: 'First Name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'text', key: 'email', required: true },
        { label: 'Phone', kind: 'text', key: 'phone', required: true },
        { label: 'Address', kind: 'text', key: 'addressLine1' },
        { label: 'City', kind: 'text', key: 'city' },
        { label: 'ZIP', kind: 'text', key: 'postalCode' },
        { label: 'Resume', kind: 'file', key: 'resume', required: true },
        { label: 'Date Available', kind: 'date', key: null },
        { label: 'Desired Pay', kind: 'text', key: null },
        { label: "It's okay to send me text messages", kind: 'checkbox', key: null },
      ],
      roundTrip: [
        { label: 'City', value: 'Portland' },
        { label: 'Desired Pay', value: 'Open to discuss' },
      ],
      resume: 'Resume',
    });

    it('reads the job description with its list items', () => {
      const doc = loadIntlFixture('generic', 'bamboohr');
      expect(site('BambooHR').readJob(doc)?.descriptionText).toMatch(/Keep our office running smoothly\.[\s\S]*Order supplies/);
    });
  });

  describe('Recruitee', () => {
    runIntlFixtureCasesOne(site('Recruitee'), 'recruitee', 'https://demostudio.recruitee.com/o/backend-developer/c/new', {
      job: { title: 'Backend Developer', company: 'Demo Studio' },
      fields: [
        { label: 'Full name', kind: 'text', key: 'fullName', required: true },
        { label: 'Email address', kind: 'email', key: 'email', required: true },
        { label: 'Phone number', kind: 'tel', key: 'phone' },
        { label: 'CV', kind: 'file', key: 'resume', required: true },
        { label: 'Cover letter', kind: 'file', key: 'coverLetter' },
        { label: 'What is your experience with Go?', kind: 'textarea', key: null },
        { label: 'Keep my details for one year', kind: 'checkbox', key: null },
      ],
      roundTrip: [{ label: 'Full name', value: 'Avery Lin' }],
      resume: 'CV',
    });
  });

  it('has at least three saved application forms across the requested hosts', () => {
    const forms = readdirSync(join(INTL_FIXTURES, 'generic')).filter((f) => f.endsWith('.html') && !f.includes('portal'));
    expect(forms.length).toBeGreaterThanOrEqual(3);
  });

  it('every requested host ships with a saved form', () => {
    const files = new Set(readdirSync(join(INTL_FIXTURES, 'generic')));
    for (const s of GENERIC_SITES) expect(files.has(`${s.siteName.toLowerCase().replace(/[^a-z0-9]+/g, '')}.html`), s.siteName).toBe(true);
  });

  it('only runs on the requested hosts and their application paths', () => {
    const doc = loadIntlFixture('generic', 'bamboohr');
    expect(site('BambooHR').matches(new URL('https://samplelabs.bamboohr.com/careers/42'), doc)).toBe(true);
    expect(site('BambooHR').matches(new URL('https://samplelabs.bamboohr.com/home'), doc)).toBe(false);
    expect(site('BambooHR').matches(new URL('https://jobs.jobvite.com/x'), doc)).toBe(false);
    for (const s of GENERIC_SITES) for (const p of s.hostPatterns) expect(p).toMatch(/^https:\/\/[^*]|^https:\/\/\*\.[a-z0-9.-]+\//);
  });

  it('needs a resume upload and an email field: an ordinary upload form is not an application', () => {
    const doc = loadIntlFixture('generic', 'bamboohr-portal');
    expect(applicationForm(doc)).toBeNull();
    expect(site('BambooHR').matches(new URL('https://samplelabs.bamboohr.com/careers/1'), doc)).toBe(false);
  });

  it('comes after every specific adapter, so a known form host always gets its own adapter', () => {
    const firstGeneric = INTL_ADAPTERS.findIndex((a) => a.id === 'generic');
    expect(INTL_ADAPTERS.slice(firstGeneric).every((a) => a.id === 'generic')).toBe(true);
    const doc = loadIntlFixture('generic', 'jobvite');
    expect(detectAdapter(new URL('https://jobs.jobvite.com/exampleco/job/oAbC123/apply'), doc, { set: 'intl', dev: false })?.siteName).toBe('Jobvite');
    expect(INTL_FILLABLE_ATS_TYPES).not.toContain('generic');
  });
});

// The generic contract is one fixture per host; the ≥3 rule is checked across hosts above.
function runIntlFixtureCasesOne(adapter: AtsAdapter, name: string, url: string, c: Omit<Parameters<typeof runIntlFixtureCases>[2][number], 'name' | 'url'>): void {
  runIntlFixtureCases(adapter, 'generic', [{ name, url, ...c }], { minFixtures: 1 });
}
