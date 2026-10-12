import { describe, expect, it } from 'vitest';

import { isMultiPage } from '../../src/adapters/intl/index';
import { successFactorsAdapter, successFactorsStepKey } from '../../src/adapters/intl/successfactors';
import { loadIntlFixture, runIntlFixtureCases } from './harness';

describe('SuccessFactors adapter', () => {
  runIntlFixtureCases(
    successFactorsAdapter,
    'successfactors',
    [
      {
        name: 'apply',
        url: 'https://career5.successfactors.com/careers?company=ExampleCoP&career_ns=job_application&career_job_req_id=1001',
        step: 'Candidate Profile',
        job: { title: 'Maintenance Engineer', company: 'Example Co', location: 'Rotterdam, NL' },
        fields: [
          { label: 'First Name', kind: 'text', key: 'firstName', required: true },
          { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
          { label: 'Email', kind: 'text', key: 'email', required: true },
          { label: 'Cell Phone', kind: 'text', key: 'phone' },
          { label: 'City', kind: 'text', key: 'city' },
          { label: 'Postal Code', kind: 'text', key: 'postalCode' },
          { label: 'Country of Residence', kind: 'select', key: 'country' },
          { label: 'Resume', kind: 'file', key: 'resume', required: true },
        ],
        roundTrip: [
          { label: 'Cell Phone', value: '+31 6 1234 5678' },
          { label: 'Country of Residence', value: 'Netherlands' },
        ],
        resume: 'Resume',
      },
      {
        name: 'apply-eu',
        url: 'https://career2.successfactors.eu/careers?career_ns=job_application&company=SampleLabsP&career_job_req_id=88',
        job: { title: 'Laborant (m/w/d)', company: 'Sample Labs' },
        fields: [
          { label: 'First Name', kind: 'text', key: 'firstName', required: true },
          { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
          { label: 'Contact E-mail', kind: 'email', key: 'email', required: true },
          { label: 'Address', kind: 'text', key: 'addressLine1' },
          { label: 'LinkedIn', kind: 'url', key: 'linkedin' },
          { label: 'CV / Resume', kind: 'file', key: 'resume' },
          { label: 'Cover Letter', kind: 'file', key: 'coverLetter' },
        ],
        roundTrip: [{ label: 'Address', value: 'Hauptstraße 1' }],
        resume: 'CV / Resume',
      },
      {
        name: 'questions',
        url: 'https://career10.successfactors.com/careers?company=DemoStudioP&career_ns=job_application',
        step: 'Questions',
        job: { company: 'Demo Studio' },
        fields: [
          { label: 'Do you have a valid work permit for Singapore?', kind: 'radio', key: null, required: true },
          { label: 'Where did you find this job?', kind: 'select', key: null },
          { label: 'What interests you about this role?', kind: 'textarea', key: null },
          { label: 'I have read the data privacy statement', kind: 'checkbox', key: null },
        ],
        roundTrip: [{ label: 'Where did you find this job?', value: 'Friend' }],
        resume: null,
      },
    ],
    { stepKey: successFactorsStepKey },
  );

  it('is multi-page and never lists the sign-in fields', () => {
    expect(isMultiPage(successFactorsAdapter)).toBe(true);
    const doc = loadIntlFixture('successfactors', 'apply-eu');
    const ids = successFactorsAdapter.listFields(doc).map((f) => f.element.id);
    expect(ids).not.toContain('fbclc_username');
    expect(ids).not.toContain('fbclc_password');
  });
});
