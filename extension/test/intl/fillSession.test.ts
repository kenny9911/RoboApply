// End to end through the supervised fill (content/fill.ts) on the WP-70 forms:
// profile values go in, protected questions come only from the user's own
// answers, nothing AI-written reaches a field, and no button is pressed.

import { describe, expect, it, vi } from 'vitest';

import { genericAdapterFor, GENERIC_SITES } from '../../src/adapters/intl/generic';
import { icimsAdapter } from '../../src/adapters/intl/icims';
import { smartRecruitersAdapter } from '../../src/adapters/intl/smartrecruiters';
import { workableAdapter } from '../../src/adapters/intl/workable';
import { workdayAdapter } from '../../src/adapters/intl/workday';
import type { AtsAdapter } from '../../src/adapters/types';
import { FillSession } from '../../src/content/fill';
import type { ApiCall } from '../../src/shared/messages';
import { fakeApi } from '../helpers';
import { deepQueryAll, findField, loadIntlFixture } from './harness';

async function run(adapter: AtsAdapter, dir: string, name: string, url: string, jobId: string | null = null) {
  const doc = loadIntlFixture(dir, name);
  const pressed = vi.fn();
  const submitted = vi.fn();
  deepQueryAll(doc, 'button, input[type="submit"], input[type="button"]').forEach((b) => b.addEventListener('click', pressed));
  doc.addEventListener('submit', submitted, true);
  const api = fakeApi();
  const s = new FillSession({ adapter, doc, url, api: api.api, jobId, aiAvailable: true });
  await s.start();
  return { doc, s, api, pressed, submitted, fields: adapter.listFields(doc) };
}

function value(fields: ReturnType<AtsAdapter['listFields']>, label: string | RegExp): string {
  return (findField(fields, label).element as HTMLInputElement).value;
}

describe('fill session on the WP-70 forms', () => {
  it('Workday "My Information": fills this page only, presses nothing', async () => {
    const r = await run(workdayAdapter, 'workday', 'my-information', 'https://exampleco.wd5.myworkdayjobs.com/en-US/External/job/x/apply');
    expect(value(r.fields, 'First Name')).toBe('Avery');
    expect(value(r.fields, 'Last Name')).toBe('Lin');
    expect(value(r.fields, 'City')).toBe('Austin');
    expect(value(r.fields, 'Postal Code')).toBe('78701');
    expect(value(r.fields, 'Email')).toBe('avery@example.test');
    expect(r.s.getState().phase).toBe('done');
    const create = r.api.calls[0] as Extract<ApiCall, { op: 'createRun' }>;
    expect(create.body).toMatchObject({ atsType: 'workday', host: 'exampleco.wd5.myworkdayjobs.com' });
    expect(r.api.ops()).not.toContain('answer');
    expect(r.pressed).not.toHaveBeenCalled();
    expect(r.submitted).not.toHaveBeenCalled();
  });

  it('Workday questions: work authorization from the user’s own record; free text waits for the user', async () => {
    const r = await run(workdayAdapter, 'workday', 'application-questions', 'https://exampleco.wd5.myworkdayjobs.com/en-US/External/job/x/apply');
    const auth = findField(r.fields, /authorized to work/);
    const sponsor = findField(r.fields, /sponsorship/);
    expect(auth.group?.find((x) => x.checked)?.value).toBe('1');
    expect(sponsor.group?.find((x) => x.checked)?.value).toBe('0');
    expect(value(r.fields, 'Why are you interested in this role?')).toBe('');
    expect(r.api.ops()).not.toContain('answer');
    expect(r.pressed).not.toHaveBeenCalled();
  });

  it('SmartRecruiters one-click: fills inside the web components, both email fields, attaches the resume', async () => {
    const r = await run(smartRecruitersAdapter, 'smartrecruiters', 'oneclick', 'https://jobs.smartrecruiters.com/oneclick-ui/company/ExampleCo/publication/x', 'job_1');
    expect(value(r.fields, 'First name')).toBe('Avery');
    expect(value(r.fields, 'Email')).toBe('avery@example.test');
    expect(value(r.fields, 'Confirm your email')).toBe('avery@example.test');
    expect(value(r.fields, 'LinkedIn profile')).toBe('https://www.linkedin.com/in/avery-example');
    expect((findField(r.fields, 'Resume').element as HTMLInputElement).files?.[0]?.name).toBe('Avery_Lin_Resume.pdf');
    expect(value(r.fields, 'Message to the hiring team')).toBe('');
    expect(r.pressed).not.toHaveBeenCalled();
    expect(r.submitted).not.toHaveBeenCalled();
  });

  it('iCIMS profile and Workable: profile fields and the resume', async () => {
    const ic = await run(icimsAdapter, 'icims', 'profile', 'https://careers-exampleco.icims.com/jobs/1234/x/candidate?in_iframe=1');
    expect(value(ic.fields, 'First Name')).toBe('Avery');
    expect((findField(ic.fields, 'State/Province').element as HTMLSelectElement).selectedOptions[0].textContent).toBe('Texas');
    expect((findField(ic.fields, 'Country').element as HTMLSelectElement).selectedOptions[0].textContent).toBe('United States');
    expect(ic.pressed).not.toHaveBeenCalled();

    const wk = await run(workableAdapter, 'workable', 'standard', 'https://apply.workable.com/exampleco/j/AB12CD34EF/apply/');
    expect(value(wk.fields, 'First name')).toBe('Avery');
    expect(value(wk.fields, 'Address')).not.toBe('');
    expect(value(wk.fields, 'Headline')).toBe('');
    expect(wk.pressed).not.toHaveBeenCalled();
  });

  it('generic (BambooHR): label heuristics fill the obvious fields; pay stays with the user', async () => {
    const bamboo = genericAdapterFor(GENERIC_SITES.find((s) => s.siteName === 'BambooHR')!);
    const r = await run(bamboo, 'generic', 'bamboohr', 'https://samplelabs.bamboohr.com/careers/42');
    expect(value(r.fields, 'First Name')).toBe('Avery');
    expect(value(r.fields, 'Email')).toBe('avery@example.test');
    expect(value(r.fields, 'ZIP')).toBe('78701');
    expect(value(r.fields, 'Desired Pay')).toBe('');
    const create = r.api.calls[0] as Extract<ApiCall, { op: 'createRun' }>;
    expect(create.body.atsType).toBe('generic');
    expect(r.pressed).not.toHaveBeenCalled();
    expect(r.submitted).not.toHaveBeenCalled();
  });
});
