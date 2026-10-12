import { describe } from 'vitest';

import { greenhouseAdapter } from '../../src/adapters/intl/greenhouse';
import { runFixtureCases } from './harness';

describe('Greenhouse adapter', () => {
  runFixtureCases(greenhouseAdapter, 'greenhouse', [
    {
      name: 'classic',
      url: 'https://boards.greenhouse.io/exampleco/jobs/1001',
      job: { title: 'Platform Engineer', company: 'Example Co', location: 'Remote, United States' },
      fields: [
        { label: 'First Name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'text', key: 'email', required: true },
        { label: 'Phone', kind: 'text', key: 'phone', required: false },
        { label: 'Resume/CV', kind: 'file', key: 'resume' },
        { label: 'Cover Letter', kind: 'file', key: 'coverLetter' },
        { label: 'LinkedIn Profile', kind: 'text', key: 'linkedin' },
        { label: 'Are you legally authorized to work in the United States?', kind: 'select', key: null, required: true },
        { label: /require sponsorship/, kind: 'select', key: null, required: true },
        { label: 'Why do you want to work at Example Co?', kind: 'textarea', key: null, required: true },
        { label: 'What are your salary expectations?', kind: 'text', key: null },
        { label: 'Gender', kind: 'select', key: null },
        { label: 'Veteran Status', kind: 'select', key: null },
      ],
      roundTrip: [
        { label: 'First Name', value: 'Avery' },
        { label: 'Email', value: 'avery@example.test' },
        { label: 'LinkedIn Profile', value: 'https://www.linkedin.com/in/avery-example' },
        { label: 'Are you legally authorized to work in the United States?', value: 'Yes' },
        { label: /require sponsorship/, value: 'No' },
        { label: 'Why do you want to work at Example Co?', value: 'Line one.\nLine two.' },
      ],
      resume: 'Resume/CV',
    },
    {
      name: 'embed',
      url: 'https://boards.greenhouse.io/embed/job_app?for=samplelabs&token=2002',
      job: { title: 'Data Analyst', company: 'Sample Labs', location: 'Taipei, Taiwan' },
      fields: [
        { label: 'First Name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
        { label: 'Email', kind: 'email', key: 'email', required: true },
        { label: 'Phone', kind: 'tel', key: 'phone' },
        { label: 'Location (City)', kind: 'text', key: 'location' },
        { label: 'Resume/CV', kind: 'file', key: 'resume' },
        { label: 'How many years of experience do you have with SQL?', kind: 'radio', key: null, required: true },
        { label: 'Website', kind: 'text', key: 'website' },
        { label: 'Tell us about a dashboard you built.', kind: 'textarea', key: null, required: true },
        { label: /I consent to Sample Labs/, kind: 'checkbox', key: null, required: false },
      ],
      roundTrip: [
        { label: 'Last Name', value: 'Lin' },
        { label: 'Location (City)', value: 'Taipei, Taiwan' },
        { label: 'How many years of experience do you have with SQL?', value: '2 to 5' },
      ],
      resume: 'Resume/CV',
    },
    {
      name: 'job-boards',
      url: 'https://job-boards.greenhouse.io/demostudio/jobs/3003',
      job: { title: 'Product Designer', company: 'Demo Studio', location: 'London, United Kingdom' },
      fields: [
        { label: 'First Name', kind: 'text', key: 'firstName', required: true },
        { label: 'Last Name', kind: 'text', key: 'lastName', required: true },
        { label: 'Preferred First Name', kind: 'text', key: 'preferredName' },
        { label: 'Email', kind: 'text', key: 'email', required: true },
        { label: 'Resume/CV', kind: 'file', key: 'resume' },
        { label: 'LinkedIn Profile', kind: 'text', key: 'linkedin' },
        { label: 'Will you require visa sponsorship to work in the UK?', kind: 'combobox', key: null, required: true },
        { label: 'What is a design decision you changed your mind about?', kind: 'textarea', key: null, required: true },
      ],
      roundTrip: [
        { label: 'First Name', value: 'Avery' },
        { label: 'Will you require visa sponsorship to work in the UK?', value: 'No' },
      ],
      resume: 'Resume/CV',
    },
  ]);
});
