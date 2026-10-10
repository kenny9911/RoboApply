import { describe, expect, it } from 'vitest';

import { isMultiPage } from '../../src/adapters/intl/index';
import { taleoAdapter, taleoStepKey } from '../../src/adapters/intl/taleo';
import { loadIntlFixture, runIntlFixtureCases } from './harness';

const URL_APPLY = 'https://exampleco.taleo.net/careersection/ex/jobapply.ftl?job=2400123&lang=en';

describe('Taleo adapter', () => {
  runIntlFixtureCases(
    taleoAdapter,
    'taleo',
    [
      {
        name: 'personal-info',
        url: URL_APPLY,
        step: 'Personal Information',
        job: { title: 'Senior Accountant (2400123)', company: 'Example Co' },
        fields: [
          { label: 'First Name', kind: 'text', key: 'firstName', required: true },
          { label: 'Middle Name', kind: 'text', key: null },
          { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
          { label: 'Email Address', kind: 'text', key: 'email', required: true },
          { label: 'Cellular Number', kind: 'text', key: 'phone' },
          { label: 'Street Address', kind: 'text', key: 'addressLine1' },
          { label: 'City', kind: 'text', key: 'city' },
          { label: 'Zip/Postal Code', kind: 'text', key: 'postalCode' },
          { label: 'Place of Residence', kind: 'select', key: 'country' },
        ],
        roundTrip: [
          { label: 'Email Address', value: 'avery@example.test' },
          { label: 'Place of Residence', value: 'Canada' },
        ],
        resume: null,
      },
      {
        name: 'attachments',
        url: 'https://samplelabs.taleo.net/careersection/2/jobapply.ftl?job=77&lang=en',
        step: 'Attachments',
        job: { company: 'Sample Labs' },
        fields: [
          { label: 'Attach a resume', kind: 'file', key: 'resume' },
          { label: 'Description of the file', kind: 'text', key: null },
          { label: 'Other attachments', kind: 'file', key: null },
        ],
        roundTrip: [{ label: 'Description of the file', value: 'Portfolio' }],
        resume: 'Attach a resume',
      },
      {
        name: 'questionnaire',
        url: 'https://demostudio.taleo.net/careersection/jobs/jobapply.ftl?job=5',
        step: 'Job-Specific Questions',
        job: { title: 'Store Associate', company: 'Demo Studio' },
        fields: [
          { label: 'Are you 18 years of age or older?', kind: 'radio', key: null, required: true },
          { label: 'Which days are you available to work?', kind: 'select', key: null },
          { label: 'Tell us why you want to work with us.', kind: 'textarea', key: null },
        ],
        roundTrip: [
          { label: 'Which days are you available to work?', value: 'Weekends' },
          { label: 'Are you 18 years of age or older?', value: 'Yes' },
        ],
        resume: null,
      },
    ],
    { stepKey: taleoStepKey },
  );

  it('is multi-page, and the sign-in dialog is never listed', () => {
    expect(isMultiPage(taleoAdapter)).toBe(true);
    const doc = loadIntlFixture('taleo', 'personal-info');
    expect(taleoAdapter.listFields(doc).some((f) => /login|User Name|Password/i.test(`${f.id} ${f.label}`))).toBe(false);
  });
});
