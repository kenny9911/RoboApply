import { describe } from 'vitest';

import { workableAdapter } from '../../src/adapters/intl/workable';
import { runIntlFixtureCases } from './harness';

describe('Workable adapter', () => {
  runIntlFixtureCases(workableAdapter, 'workable', [
    {
      name: 'standard',
      url: 'https://apply.workable.com/exampleco/j/AB12CD34EF/apply/',
      job: { title: 'Product Designer', company: 'Example Co', location: 'Lisbon, Portugal' },
      fields: [
        { label: 'First name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Headline', kind: 'text', key: null },
        { label: 'Phone', kind: 'tel', key: 'phone' },
        { label: 'Address', kind: 'text', key: 'location' },
        { label: 'Resume', kind: 'file', key: 'resume', required: true },
        { label: 'Summary', kind: 'textarea', key: null },
        { label: 'Cover letter', kind: 'textarea', key: 'coverLetter' },
      ],
      roundTrip: [
        { label: 'Headline', value: 'Product designer, 6 years' },
        { label: 'Address', value: 'Lisbon' },
      ],
      resume: 'Resume',
    },
    {
      name: 'questions',
      url: 'https://apply.workable.com/samplelabs/j/9F8E7D6C5B/apply/',
      job: { title: 'Operations Lead', company: 'Sample Labs', location: 'Toronto, Ontario, Canada' },
      fields: [
        { label: 'First name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Resume', kind: 'file', key: 'resume' },
        { label: 'Are you legally entitled to work in Canada?', kind: 'radio', key: null, required: true },
        { label: 'Notice period', kind: 'select', key: null },
        { label: "What would you improve in your last team's operations?", kind: 'textarea', key: null },
        { label: 'Preferred work arrangement', kind: 'radio', key: null },
        { label: 'Keep my data for future roles', kind: 'checkbox', key: null },
      ],
      roundTrip: [
        { label: 'Notice period', value: '2 weeks' },
        { label: 'Preferred work arrangement', value: 'Hybrid' },
      ],
      resume: 'Resume',
    },
    {
      name: 'minimal',
      url: 'https://apply.workable.com/demostudio/j/1A2B3C4D5E/apply/',
      job: { title: 'Barista', company: 'Demo Studio' },
      fields: [
        { label: 'First name', kind: 'text', key: 'firstName' },
        { label: 'Last name', kind: 'text', key: 'lastName' },
        { label: 'Email', kind: 'email', key: 'email' },
        { label: 'CV', kind: 'file', key: 'resume' },
      ],
      roundTrip: [{ label: 'Email', value: 'avery@example.test' }],
      resume: 'CV',
    },
  ]);
});
