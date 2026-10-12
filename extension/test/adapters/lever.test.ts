import { describe } from 'vitest';

import { leverAdapter } from '../../src/adapters/intl/lever';
import { runFixtureCases } from './harness';

describe('Lever adapter', () => {
  runFixtureCases(leverAdapter, 'lever', [
    {
      name: 'standard',
      url: 'https://jobs.lever.co/exampleco/abc-123/apply',
      job: { title: 'Backend Engineer', company: 'Example Co', location: 'Austin, Texas' },
      fields: [
        { label: 'Resume/CV', kind: 'file', key: 'resume', required: true },
        { label: 'Full name', kind: 'text', key: 'fullName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Phone', kind: 'text', key: 'phone' },
        { label: 'Current company', kind: 'text', key: 'currentCompany' },
        { label: 'LinkedIn URL', kind: 'text', key: 'linkedin' },
        { label: 'GitHub URL', kind: 'text', key: 'github' },
        { label: 'Portfolio URL', kind: 'text', key: 'portfolio' },
        { label: 'Are you authorized to work in the United States?', kind: 'radio', key: null, required: true },
        { label: 'Anything else you want us to know?', kind: 'textarea', key: null },
        { label: 'Gender', kind: 'select', key: null },
        { label: 'Veteran status', kind: 'select', key: null },
      ],
      roundTrip: [
        { label: 'Full name', value: 'Avery Lin' },
        { label: 'GitHub URL', value: 'https://github.com/avery-example' },
        { label: 'Are you authorized to work in the United States?', value: 'Yes' },
        { label: 'Gender', value: 'Female' },
      ],
      resume: 'Resume/CV',
    },
    {
      name: 'custom-cards',
      url: 'https://jobs.lever.co/samplelabs/def-456/apply',
      job: { title: 'Support Specialist', company: 'Sample Labs', location: 'Remote' },
      fields: [
        { label: 'Resume/CV', kind: 'file', key: 'resume', required: true },
        { label: 'Full name', kind: 'text', key: 'fullName' },
        { label: 'Email', kind: 'email', key: 'email' },
        { label: 'Current location', kind: 'text', key: 'location' },
        { label: 'How did you hear about this job?', kind: 'select', key: null },
        { label: 'Will you now or in the future require visa sponsorship?', kind: 'radio', key: null, required: true },
        { label: 'What are your salary expectations?', kind: 'text', key: null, required: true },
        { label: 'How many years of customer support experience do you have?', kind: 'text', key: null },
        { label: 'Which tools have you used? — Zendesk', kind: 'checkbox', key: null },
        { label: 'Which tools have you used? — Intercom', kind: 'checkbox', key: null },
        { label: 'Describe a time you calmed down an upset customer.', kind: 'textarea', key: null, required: true },
      ],
      roundTrip: [
        { label: 'Current location', value: 'Austin, Texas' },
        { label: 'How did you hear about this job?', value: 'Company website' },
        { label: 'Will you now or in the future require visa sponsorship?', value: 'No' },
      ],
      resume: 'Resume/CV',
    },
    {
      name: 'eu-minimal',
      url: 'https://jobs.eu.lever.co/demostudio/ghi-789/apply',
      job: { title: 'Junior Developer', company: 'Demo Studio', location: 'Berlin' },
      fields: [
        { label: 'Full name', kind: 'text', key: 'fullName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Resume/CV', kind: 'file', key: 'resume', required: false },
        { label: 'Twitter URL', kind: 'text', key: 'x' },
        { label: 'Keep my details on file for future roles', kind: 'checkbox', key: null },
      ],
      roundTrip: [
        { label: 'Email', value: 'avery@example.test' },
        { label: 'Twitter URL', value: 'https://x.com/avery' },
      ],
      resume: 'Resume/CV',
    },
  ]);
});
