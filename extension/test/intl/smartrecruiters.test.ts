import { describe, expect, it } from 'vitest';

import { smartRecruitersAdapter } from '../../src/adapters/intl/smartrecruiters';
import { loadIntlFixture, runIntlFixtureCases } from './harness';

describe('SmartRecruiters adapter', () => {
  runIntlFixtureCases(smartRecruitersAdapter, 'smartrecruiters', [
    {
      name: 'oneclick',
      url: 'https://jobs.smartrecruiters.com/oneclick-ui/company/ExampleCo/publication/2c3f0b8e-0000-4000-8000-000000000001?dcr_ci=ExampleCo',
      job: { title: 'Customer Success Manager', company: 'Example Co', location: 'Denver, CO, United States' },
      fields: [
        { label: 'First name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Confirm your email', kind: 'email', key: 'email', required: true },
        { label: 'City', kind: 'text', key: 'location' },
        { label: 'Phone number', kind: 'tel', key: 'phone' },
        { label: 'Resume', kind: 'file', key: 'resume' },
        { label: 'LinkedIn profile', kind: 'url', key: 'linkedin' },
        { label: 'Message to the hiring team', kind: 'textarea', key: null },
        { label: 'I have read the privacy notice', kind: 'checkbox', key: null, required: true },
      ],
      roundTrip: [
        { label: 'First name', value: 'Avery' },
        { label: 'Confirm your email', value: 'avery@example.test' },
        { label: 'Message to the hiring team', value: 'I would like to talk about this role.' },
      ],
      resume: 'Resume',
    },
    {
      name: 'classic',
      url: 'https://jobs.smartrecruiters.com/SampleLabs/743999999999999-field-technician',
      job: { title: 'Field Technician', company: 'Sample Labs', location: 'Leeds, United Kingdom' },
      fields: [
        { label: 'First name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Phone number', kind: 'tel', key: 'phone' },
        { label: 'City', kind: 'text', key: 'location' },
        { label: 'How did you hear about us?', kind: 'select', key: null },
        { label: 'Do you hold a full UK driving licence?', kind: 'radio', key: null, required: true },
        { label: 'Resume', kind: 'file', key: 'resume', required: true },
      ],
      roundTrip: [
        { label: 'How did you hear about us?', value: 'Referral' },
        { label: 'Do you hold a full UK driving licence?', value: 'Yes' },
      ],
      resume: 'Resume',
    },
    {
      name: 'screening',
      url: 'https://jobs.smartrecruiters.com/DemoStudio/744000000000001-werkstudent-marketing',
      job: { title: 'Werkstudent Marketing (m/w/d)', company: 'Demo Studio GmbH', location: 'Berlin, Germany' },
      fields: [
        { label: 'First name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Are you legally authorized to work in Germany?', kind: 'radio', key: null, required: true },
        { label: 'How many hours per week can you work?', kind: 'select', key: null },
        { label: 'Which marketing tools have you used?', kind: 'textarea', key: null },
        { label: 'Keep my details for future openings', kind: 'checkbox', key: null },
        { label: 'Resume', kind: 'file', key: 'resume' },
      ],
      roundTrip: [
        { label: 'How many hours per week can you work?', value: '16 to 20' },
        { label: 'Are you legally authorized to work in Germany?', value: 'No' },
      ],
      resume: 'Resume',
    },
    {
      // The form component keeps its controls directly in its own shadow root.
      name: 'oneclick-shadow',
      url: 'https://jobs.smartrecruiters.com/oneclick-ui/company/SampleLabs/publication/2c3f0b8e-0000-4000-8000-000000000002',
      job: { title: 'Store Supervisor', company: 'Sample Labs', location: 'Manchester, United Kingdom' },
      fields: [
        { label: 'First name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Phone number', kind: 'tel', key: 'phone' },
        { label: 'Resume', kind: 'file', key: 'resume' },
        { label: 'Notice period', kind: 'select', key: null },
      ],
      roundTrip: [
        { label: 'First name', value: 'Avery' },
        { label: 'Notice period', value: '1 month' },
      ],
      resume: 'Resume',
    },
  ]);

  it('reads controls in the form component’s own shadow root', () => {
    const doc = loadIntlFixture('smartrecruiters', 'oneclick-shadow');
    const form = doc.querySelector('oc-oneclick-form')!;
    const fields = smartRecruitersAdapter.listFields(doc);
    expect(fields.filter((f) => f.element.getRootNode() === form.shadowRoot).map((f) => f.label)).toEqual(['First name', 'Last name', 'Email', 'Resume', 'Notice period']);
  });

  it('reads fields inside the form’s web components, in page order', () => {
    const doc = loadIntlFixture('smartrecruiters', 'oneclick');
    const fields = smartRecruitersAdapter.listFields(doc);
    expect(fields.filter((f) => f.element.getRootNode() !== doc).length).toBeGreaterThan(5);
    // The submit button inside a component is never listed.
    expect(fields.some((f) => /submit/i.test(f.label))).toBe(false);
  });
});
