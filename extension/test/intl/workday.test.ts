import { describe, expect, it, vi } from 'vitest';

import { formPageKey, formStepKey, isMultiPage } from '../../src/adapters/intl/index';
import { workdayAdapter, workdayStepKey } from '../../src/adapters/intl/workday';
import type { AtsAdapter } from '../../src/adapters/types';
import { createContentController } from '../../src/content/controller';
import type { MountedPanel } from '../../src/content/panel/mount';
import { PAGE_ID, loadIntlFixture, runIntlFixtureCases, showIntlPage } from './harness';

const showWorkdayPage = (name: string) => showIntlPage('workday', name);

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

  // R4 (WP-93): content/controller.ts keys detection and mounting by
  // formPageKey(adapter, doc, pageKey); the panel keeps its fill session, so
  // the next page of the same application is a second fill of the same run.
  // The page-level flow (one createRun, "Fill this page" offered again) is in
  // test/intl/workdayPages.test.tsx.
  it('R4: the controller keeps the panel when the form moves to its next page at the same href, and tells it to look again', () => {
    showWorkdayPage('my-information');
    let href = URL_APPLY;
    const panels: Array<{ open: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn> }> = [];
    const mount = vi.fn((_adapter: AtsAdapter, _url: string, _open: boolean): MountedPanel => {
      const panel = { open: vi.fn(), refresh: vi.fn(), unmount: vi.fn() };
      panels.push(panel);
      return { host: document.createElement('div'), ...panel };
    });
    const controller = createContentController({ doc: document, href: () => href, set: 'intl', dev: false, mount });

    controller.init();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0]![0].id).toBe('workday');

    // Same page: nothing new.
    expect(controller.handle({ type: 'content.ping' })).toEqual({ siteName: 'Workday' });
    expect(panels[0]!.refresh).not.toHaveBeenCalled();

    // Workday's own "Save and Continue": the step changes, the URL does not.
    showWorkdayPage('my-experience');
    expect(formPageKey(workdayAdapter, document, 'k')).toBe('k#step=My%20Experience');
    expect(controller.handle({ type: 'content.ping' })).toEqual({ siteName: 'Workday' });
    expect(mount).toHaveBeenCalledTimes(1);
    expect(panels[0]!.unmount).not.toHaveBeenCalled();
    expect(panels[0]!.refresh).toHaveBeenCalledTimes(1);

    // The toolbar's "Fill this form" on the third page opens the same panel.
    showWorkdayPage('application-questions');
    expect(controller.handle({ type: 'panel.open' })).toEqual({ ok: true });
    expect(mount).toHaveBeenCalledTimes(1);
    expect(panels[0]!.refresh).toHaveBeenCalledTimes(2);
    expect(panels[0]!.open).toHaveBeenCalledTimes(1);

    // The form is gone but the URL is the same (e.g. the site's own confirmation page):
    // the panel, with its "Did you submit this application?", stays.
    document.getElementById(PAGE_ID)!.innerHTML = '<p>Thank you.</p>';
    controller.handle({ type: 'content.ping' });
    expect(panels[0]!.unmount).not.toHaveBeenCalled();
    expect(mount).toHaveBeenCalledTimes(1);

    // Another application (another path) is a different form: a new panel.
    showWorkdayPage('my-information');
    href = URL_APPLY.replace('Backend-Engineer_R1234', 'Data-Engineer_R9');
    controller.handle({ type: 'content.ping' });
    expect(panels[0]!.unmount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(2);
  });

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
