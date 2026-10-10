import { describe, expect, it } from 'vitest';

import { icimsAdapter } from '../../src/adapters/intl/icims';
import { loadIntlFixture, runIntlFixtureCases } from './harness';

describe('iCIMS adapter', () => {
  runIntlFixtureCases(icimsAdapter, 'icims', [
    {
      name: 'profile',
      url: 'https://careers-exampleco.icims.com/jobs/1234/warehouse-supervisor/candidate?in_iframe=1',
      job: { title: 'Warehouse Supervisor', company: 'Example Co' },
      fields: [
        { label: 'First Name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Phone', kind: 'tel', key: 'phone' },
        { label: 'Address', kind: 'text', key: 'addressLine1' },
        { label: 'City', kind: 'text', key: 'city' },
        { label: 'State/Province', kind: 'select', key: 'region' },
        { label: 'Zip/Postal Code', kind: 'text', key: 'postalCode' },
        { label: 'Country', kind: 'select', key: 'country' },
        { label: 'Upload your resume', kind: 'file', key: 'resume' },
      ],
      roundTrip: [
        { label: 'First Name', value: 'Avery' },
        { label: 'State/Province', value: 'Texas' },
        { label: 'Country', value: 'United States' },
      ],
      resume: 'Upload your resume',
    },
    {
      name: 'questions',
      url: 'https://careers-samplelabs.icims.com/jobs/5678/lab-technician-ii/questions?in_iframe=1',
      job: { title: 'Lab Technician II', company: 'Sample Labs' },
      fields: [
        { label: 'Are you at least 18 years of age?', kind: 'radio', key: null, required: true },
        { label: 'Which shift do you prefer?', kind: 'select', key: null },
        { label: 'Tell us about your lab experience.', kind: 'textarea', key: null },
        { label: 'LinkedIn Profile URL', kind: 'text', key: 'linkedin' },
        { label: 'Cover Letter', kind: 'file', key: 'coverLetter' },
      ],
      roundTrip: [
        { label: 'Which shift do you prefer?', value: 'Night' },
        { label: 'Are you at least 18 years of age?', value: 'Yes' },
      ],
      resume: null,
    },
    {
      name: 'login-then-apply',
      url: 'https://uscareers-demostudio.icims.com/jobs/42/junior-designer/login',
      job: { title: 'Junior Designer', company: 'Demo Studio' },
      fields: [
        { label: 'First Name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Mobile Phone', kind: 'tel', key: 'phone' },
        { label: 'Resume', kind: 'file', key: 'resume', required: true },
        { label: 'I agree to be contacted about this role', kind: 'checkbox', key: null },
      ],
      roundTrip: [{ label: 'Mobile Phone', value: '+1 512 555 0100' }],
      resume: 'Resume',
    },
  ]);

  it('never lists the sign-in box or a password', () => {
    const doc = loadIntlFixture('icims', 'login-then-apply');
    const ids = icimsAdapter.listFields(doc).map((f) => f.element.id);
    expect(ids).not.toContain('login_email');
    expect(ids).not.toContain('login_password');
  });
});
