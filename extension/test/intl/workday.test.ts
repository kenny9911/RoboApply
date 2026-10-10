import { describe, expect, it } from 'vitest';

import { formStepKey, isMultiPage } from '../../src/adapters/intl/index';
import { workdayAdapter, workdayStepKey } from '../../src/adapters/intl/workday';
import { loadIntlFixture, runIntlFixtureCases } from './harness';

const URL_APPLY = 'https://exampleco.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Backend-Engineer_R1234/apply/applyManually';

describe('Workday adapter', () => {
  runIntlFixtureCases(
    workdayAdapter,
    'workday',
    [
      {
        name: 'my-information',
        url: URL_APPLY,
        step: 'My Information',
        job: { company: 'Example Co' },
        fields: [
          { label: 'Have you previously worked for Example Co?', kind: 'radio', key: null, required: true },
          { label: 'First Name', kind: 'text', key: 'firstName', required: true },
          { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
          { label: 'I have a preferred name', kind: 'checkbox', key: null },
          { label: 'Address Line 1', kind: 'text', key: 'addressLine1' },
          { label: 'City', kind: 'text', key: 'city' },
          { label: 'Postal Code', kind: 'text', key: 'postalCode' },
          { label: 'Email', kind: 'text', key: 'email' },
          { label: 'Phone Number', kind: 'text', key: 'phone', required: true },
          { label: 'Phone Extension', kind: 'text', key: null, required: false },
        ],
        roundTrip: [
          { label: 'First Name', value: 'Avery' },
          { label: 'Phone Number', value: '5125550100' },
          { label: 'Have you previously worked for Example Co?', value: 'No' },
        ],
        resume: null,
      },
      {
        name: 'my-experience',
        url: URL_APPLY,
        step: 'My Experience',
        job: null,
        fields: [
          { label: 'Job Title', kind: 'text', key: 'currentTitle', required: true },
          { label: 'Company', kind: 'text', key: 'currentCompany' },
          { label: 'Location', kind: 'text', key: 'location' },
          { label: 'I currently work here', kind: 'checkbox', key: null },
          { label: 'From — Month', kind: 'text', key: null, required: true },
          { label: 'From — Year', kind: 'text', key: null, required: true },
          { label: 'Role Description', kind: 'textarea', key: null },
          { label: 'School or University', kind: 'text', key: null },
          { label: 'Resume/CV', kind: 'file', key: 'resume' },
          { label: 'URL', kind: 'text', key: null },
          { label: 'LinkedIn', kind: 'text', key: 'linkedin' },
        ],
        roundTrip: [
          { label: 'Company', value: 'Prior Corp' },
          { label: 'Role Description', value: 'Built the billing service.' },
          { label: 'LinkedIn', value: 'https://www.linkedin.com/in/avery-example' },
        ],
        resume: 'Resume/CV',
      },
      {
        name: 'newer-tenant',
        url: 'https://samplelabs.wd1.myworkdaysite.com/recruiting/samplelabs/careers/job/Remote/Data-Analyst_R77/apply',
        step: 'My Information',
        job: { title: 'Data Analyst', company: 'Sample Labs', location: 'Remote - US' },
        fields: [
          { label: 'Given Name(s)', kind: 'text', key: 'firstName', required: true },
          { label: 'Family Name', kind: 'text', key: 'lastName', required: true },
          { label: 'Preferred Given Name', kind: 'text', key: 'preferredName' },
          { label: 'Preferred Family Name', kind: 'text', key: null },
          { label: 'Address Line 1', kind: 'text', key: 'addressLine1' },
          { label: 'City', kind: 'text', key: 'city' },
          { label: 'ZIP Code', kind: 'text', key: 'postalCode' },
          { label: 'Email Address', kind: 'text', key: 'email' },
          { label: 'Phone Number', kind: 'text', key: 'phone', required: true },
        ],
        roundTrip: [
          { label: 'Family Name', value: 'Lin' },
          { label: 'ZIP Code', value: '78701' },
        ],
        resume: null,
      },
      {
        name: 'application-questions',
        url: URL_APPLY,
        step: 'Application Questions',
        job: { company: 'Example Co' },
        fields: [
          { label: 'Are you legally authorized to work in the United States?', kind: 'radio', key: null, required: true },
          { label: 'Will you now or in the future require sponsorship for employment visa status?', kind: 'radio', key: null, required: true },
          { label: 'Why are you interested in this role?', kind: 'textarea', key: null },
          { label: 'I confirm the information I gave is accurate.', kind: 'checkbox', key: null },
        ],
        roundTrip: [
          { label: /authorized to work/, value: 'Yes' },
          { label: /sponsorship/, value: 'No' },
        ],
        resume: null,
      },
    ],
    { stepKey: workdayStepKey },
  );

  it('is a multi-page form: each page is its own fill, keyed by the step', () => {
    expect(isMultiPage(workdayAdapter)).toBe(true);
    expect(formStepKey(workdayAdapter, loadIntlFixture('workday', 'my-information'))).toBe('My Information');
    expect(formStepKey(workdayAdapter, loadIntlFixture('workday', 'my-experience'))).toBe('My Experience');
  });

  // R4 (INT controller + WP-71 panel): key detection/mounting by
  // formPageKey(adapter, doc, pageKey), offer "Fill this page" again when the
  // step changes, and keep one run (one autofill credit) per application.
  it.todo('R4: after filling My Information, swapping in My Experience at the same href offers a second fill and creates no second run');

  it('leaves Workday dropdown buttons and multi-select prompts to the user', () => {
    const doc = loadIntlFixture('workday', 'my-information');
    const fields = workdayAdapter.listFields(doc);
    const els = new Set(fields.map((f) => f.element));
    for (const el of Array.from(doc.querySelectorAll('[aria-haspopup="listbox"], [data-automation-id="searchBox"]'))) expect(els.has(el as HTMLElement)).toBe(false);
    // The site's own job search box is outside the application page.
    expect(fields.some((f) => f.label === 'Search for jobs')).toBe(false);
  });

  it('serves every Workday tenant host and nothing else', () => {
    const doc = loadIntlFixture('workday', 'my-information');
    expect(workdayAdapter.matches(new URL('https://acme.wd103.myworkdayjobs.com/x'), doc)).toBe(true);
    expect(workdayAdapter.matches(new URL('https://myworkdayjobs.com.evil.test/x'), doc)).toBe(false);
    expect(workdayAdapter.hostPatterns).toEqual(['https://*.myworkdayjobs.com/*', 'https://*.myworkdaysite.com/*']);
  });
});
