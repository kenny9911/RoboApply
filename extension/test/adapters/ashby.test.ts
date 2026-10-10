import { describe } from 'vitest';

import { ashbyAdapter } from '../../src/adapters/intl/ashby';
import { runFixtureCases } from './harness';

describe('Ashby adapter', () => {
  runFixtureCases(ashbyAdapter, 'ashby', [
    {
      name: 'standard',
      url: 'https://jobs.ashbyhq.com/exampleco/0b1c/application',
      job: { title: 'Site Reliability Engineer', company: 'Example Co', location: 'Remote (US)' },
      fields: [
        { label: 'Name', kind: 'text', key: 'fullName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Resume', kind: 'file', key: 'resume', required: true },
        { label: 'Phone Number', kind: 'tel', key: 'phone' },
        { label: 'LinkedIn Profile', kind: 'url', key: 'linkedin' },
        { label: 'Location', kind: 'combobox', key: 'location' },
        { label: 'What draws you to this role?', kind: 'textarea', key: null, required: true },
      ],
      roundTrip: [
        { label: 'Name', value: 'Avery Lin' },
        { label: 'Phone Number', value: '+15125550100' },
        { label: 'Location', value: 'Austin, Texas, United States' },
      ],
      resume: 'Resume',
    },
    {
      name: 'eeo',
      url: 'https://jobs.ashbyhq.com/samplelabs/7d8e/application',
      job: { title: 'Account Executive', company: 'Sample Labs' },
      fields: [
        { label: 'Name', kind: 'text', key: 'fullName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Resume', kind: 'file', key: 'resume', required: true },
        { label: 'Current Company', kind: 'text', key: 'currentCompany' },
        { label: 'Gender', kind: 'radio', key: null },
        { label: 'Veteran Status', kind: 'select', key: null },
        { label: 'What was your quota attainment last year?', kind: 'text', key: null },
      ],
      roundTrip: [
        { label: 'Current Company', value: 'Prior Corp' },
        { label: 'Gender', value: 'Decline to self-identify' },
        { label: 'Veteran Status', value: 'I am not a protected veteran' },
      ],
      resume: 'Resume',
    },
    {
      name: 'minimal',
      url: 'https://jobs.ashbyhq.com/demostudio/aa11/application',
      job: { title: 'Office Coordinator', company: 'Demo Studio' },
      fields: [
        { label: 'Name', kind: 'text', key: 'fullName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Resume', kind: 'file', key: 'resume', required: false },
        { label: 'Pronouns', kind: 'text', key: null },
        { label: 'You may contact me about other openings', kind: 'checkbox', key: null },
      ],
      roundTrip: [{ label: 'Email', value: 'avery@example.test' }],
      resume: 'Resume',
    },
  ]);
});
