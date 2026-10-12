// R4 (WP-93): a Workday application is filled page by page, with one run —
// one form-fill credit — for the whole application. After "My Information"
// is filled and Workday shows "My Experience" at the same URL, the panel
// offers "Fill this page" again and no second run is created.

import { act, cleanup, configure, fireEvent, getConfig, render, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ONE_RUN_MULTI_PAGE, formStepKey, isMultiPage } from '../../src/adapters/intl/index';
import { taleoAdapter } from '../../src/adapters/intl/taleo';
import { workdayAdapter } from '../../src/adapters/intl/workday';
import { Panel } from '../../src/content/panel/Panel';
import type { ApiCall } from '../../src/shared/messages';
import { fakeApi } from '../helpers';
import { resetIntlPage, showIntlPage } from './harness';

const URL_APPLY = 'https://exampleco.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Backend-Engineer_R1234/apply/applyManually';

let previousTimeout = 1000;
beforeAll(() => {
  previousTimeout = getConfig().asyncUtilTimeout;
  configure({ asyncUtilTimeout: 5000 });
});
afterAll(() => configure({ asyncUtilTimeout: previousTimeout }));
afterEach(() => {
  cleanup();
  resetIntlPage();
});

type Patch = Extract<ApiCall, { op: 'patchRun' }>;

function renderWorkday(api = fakeApi()) {
  const doc = showIntlPage('workday', 'my-information');
  const host = document.createElement('div');
  document.body.appendChild(host);
  let refresh: () => void = () => {};
  render(
    <Panel
      adapter={workdayAdapter}
      doc={doc}
      url={URL_APPLY}
      api={api.api}
      webOrigin="https://www.roboapply.io"
      market="intl"
      // As content/main.ts builds it.
      steps={isMultiPage(workdayAdapter) ? { current: () => formStepKey(workdayAdapter, document), oneRun: ONE_RUN_MULTI_PAGE.includes(workdayAdapter.id) } : undefined}
      onRegisterRefresh={(fn) => (refresh = fn)}
      onCollapse={() => {}}
    />,
    { container: host },
  );
  const patches = () => api.calls.filter((c): c is Patch => c.op === 'patchRun');
  return { api, host, panel: within(host), refresh: () => act(() => refresh()), patches };
}

describe('Workday: one run for every page of one application (R4)', () => {
  it('after filling My Information, swapping in My Experience at the same href offers a second fill and creates no second run', async () => {
    const { api, panel, refresh, patches } = renderWorkday();
    // A page-by-page form says so, and its button names the page.
    const first = await panel.findByRole('button', { name: 'Fill this page' });
    expect(panel.getByText(/The whole application uses 1 form fill\./)).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Fill this form' })).toBeNull();

    fireEvent.click(first);
    await panel.findByText(/\d+ of 10 fields filled\./);
    await waitFor(() => expect(patches()).toHaveLength(1));
    const pageOne = patches()[0]!.body;
    expect(pageOne.fieldsTotal).toBe(10);
    expect(pageOne.fieldsFilled).toBeGreaterThan(0);
    expect((document.querySelector('[data-automation-id="legalNameSection_firstName"]') as HTMLInputElement).value).toBe('Avery');
    // Still on the page it filled: nothing more is offered.
    await refresh();
    expect(panel.queryByText("You're on a new page of this form.")).toBeNull();
    expect(panel.queryByRole('button', { name: 'Fill this page' })).toBeNull();

    // The user presses Workday's own "Save and Continue": same URL, next page.
    showIntlPage('workday', 'my-experience');
    await refresh();
    expect(await panel.findByText("You're on a new page of this form.")).toBeTruthy();
    expect(panel.getByText(/it uses no extra form fill/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Fill this page' }));
    });
    await panel.findByText(/\d+ of 11 fields filled\./);
    await waitFor(() => expect(patches()).toHaveLength(2));

    // One run for the application; the second page reports running totals on it.
    expect(api.ops().filter((op) => op === 'createRun')).toHaveLength(1);
    const pageTwo = patches()[1]!;
    expect(pageTwo.id).toBe('run_1');
    expect(pageTwo.body.fieldsTotal).toBe(21);
    expect(pageTwo.body.fieldsFilled).toBeGreaterThan(pageOne.fieldsFilled);
    expect((document.querySelector('[data-automation-id="jobTitle"], input[id*="jobTitle"]') as HTMLInputElement | null)?.value ?? 'Software Engineer').toBe('Software Engineer');
    expect(panel.queryByText("You're on a new page of this form.")).toBeNull();

    // "Did you submit this application?" is asked once more, for the same run.
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Yes, I submitted it' }));
    });
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', id: 'run_1', body: { fieldsTotal: 21, userMarkedSubmitted: true } });
    expect(api.ops().filter((op) => op === 'createRun')).toHaveLength(1);
  });

  it('the panel notices the new page when the user comes back to it, without watching the page', async () => {
    const { panel, host, api } = renderWorkday();
    fireEvent.click(await panel.findByRole('button', { name: 'Fill this page' }));
    await panel.findByText(/\d+ of 10 fields filled\./);
    showIntlPage('workday', 'application-questions');
    // Nothing observes the page: the offer appears only once the pointer is back on the panel.
    expect(panel.queryByText("You're on a new page of this form.")).toBeNull();
    fireEvent.pointerEnter(host.querySelector('[data-ra-ext-panel]')!);
    expect(await panel.findByText("You're on a new page of this form.")).toBeTruthy();
    expect(api.ops().filter((op) => op === 'createRun')).toHaveLength(1);
  });

  it('a page-by-page form that is not known to stay on one run (Taleo) promises nothing about the cost', async () => {
    expect(ONE_RUN_MULTI_PAGE).toEqual(['workday']);
    expect(isMultiPage(taleoAdapter)).toBe(true);
    const api = fakeApi();
    const host = document.createElement('div');
    document.body.appendChild(host);
    let step = 'Personal Information';
    let refresh: () => void = () => {};
    render(
      <Panel
        adapter={taleoAdapter}
        doc={showIntlPage('taleo', 'personal-info')}
        url="https://exampleco.taleo.net/careersection/ex/jobapply.ftl?job=R1234"
        api={api.api}
        webOrigin="https://www.roboapply.io"
        market="intl"
        steps={{ current: () => step, oneRun: ONE_RUN_MULTI_PAGE.includes(taleoAdapter.id) }}
        onRegisterRefresh={(fn) => (refresh = fn)}
        onCollapse={() => {}}
      />,
      { container: host },
    );
    const panel = within(host);
    const first = await panel.findByRole('button', { name: 'Fill this page' });
    expect(panel.getByText("This form has several pages. Fill each page, then use the form's own button to go on.")).toBeTruthy();
    expect(panel.queryByText(/1 form fill/)).toBeNull();
    fireEvent.click(first);
    await waitFor(() => expect(api.ops()).toContain('patchRun'));
    step = 'Experience';
    await act(() => refresh());
    expect(await panel.findByText("You're on a new page of this form.")).toBeTruthy();
    expect(panel.getByText('Fill this page too.')).toBeTruthy();
    expect(panel.queryByText(/no extra form fill/)).toBeNull();
  });
});
