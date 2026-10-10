// The side panel: job card + fit, Fill this form, checklist, drafts only in the
// panel until "Use this answer", the D1 closing lines, and the submitted question.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { greenhouseAdapter } from '../src/adapters/intl/greenhouse';
import { Panel } from '../src/content/panel/Panel';
import { mountPanel } from '../src/content/panel/mount';
import { fail, fakeApi, field, loadFixture } from './helpers';

const URL_GH = 'https://boards.greenhouse.io/exampleco/jobs/1001';

function renderPanel(api = fakeApi(), market: 'intl' | 'cn' = 'intl') {
  const doc = loadFixture('greenhouse', 'classic');
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<Panel adapter={greenhouseAdapter} doc={doc} url={URL_GH} api={api.api} webOrigin="https://www.roboapply.io" market={market} onCollapse={() => {}} />, { container: host });
  return { api, panel: within(host) };
}

describe('Panel', () => {
  it('shows the job with its fit tier and the required fit line', async () => {
    const { panel, api } = renderPanel();
    expect(await panel.findByText('Platform Engineer')).toBeTruthy();
    expect(panel.getByText('Example Co · Remote, United States')).toBeTruthy();
    expect(await panel.findByText('Great fit')).toBeTruthy();
    expect(panel.getByText('82 / 100')).toBeTruthy();
    expect(panel.getByText('Quick estimate')).toBeTruthy();
    expect(panel.getByText('This is not your chance of getting hired.')).toBeTruthy();
    expect(api.ops()).toEqual(['me', 'pageJob']);
    expect(api.calls[1]).toMatchObject({ op: 'pageJob', body: { url: URL_GH, title: 'Platform Engineer', company: 'Example Co' } });
  });

  it('fills on click, shows the checklist, and keeps an AI draft in the panel until "Use this answer"', async () => {
    const { panel, api } = renderPanel();
    await panel.findByText('Great fit');
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    expect(await panel.findByText(/8 of 13 fields filled\./)).toBeTruthy();
    expect(panel.getByText('Check the form, then submit it yourself.')).toBeTruthy();
    expect(panel.getByText('Did you submit this application?')).toBeTruthy();
    expect(field('#first_name').value).toBe('Avery');

    const why = panel.getByText('Why do you want to work at Example Co?').closest('li')!;
    fireEvent.click(within(why as HTMLElement).getByRole('button', { name: 'Write a draft' }));
    const box = (await within(why as HTMLElement).findByRole('textbox', { name: /Draft answer for/ })) as HTMLTextAreaElement;
    expect(box.value).toBe('I like small teams that ship often.');
    expect(within(why as HTMLElement).getByText('AI-generated')).toBeTruthy();
    expect(within(why as HTMLElement).getByText(/Written by AI/)).toBeTruthy();
    const page = field<HTMLTextAreaElement>('#job_application_answers_attributes_3_text_value');
    expect(page.value).toBe('');

    fireEvent.change(box, { target: { value: 'My own words.' } });
    expect(page.value).toBe('');
    await act(async () => {
      fireEvent.click(within(why as HTMLElement).getByRole('button', { name: 'Use this answer' }));
    });
    await waitFor(() => expect(page.value).toBe('My own words.'));
    expect(api.ops().filter((o) => o === 'answer')).toHaveLength(1);
  });

  it('"Save this answer" appears only after the user used a draft, and saves on the click (F-EXT-04)', async () => {
    const { panel, api } = renderPanel();
    await panel.findByText('Great fit');
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    await panel.findByText(/8 of 13 fields filled\./);
    expect(panel.queryByRole('button', { name: 'Save this answer' })).toBeNull();
    const why = panel.getByText('Why do you want to work at Example Co?').closest('li') as HTMLElement;
    fireEvent.click(within(why).getByRole('button', { name: 'Write a draft' }));
    await within(why).findByRole('textbox', { name: /Draft answer for/ });
    expect(within(why).queryByRole('button', { name: 'Save this answer' })).toBeNull();
    await act(async () => {
      fireEvent.click(within(why).getByRole('button', { name: 'Use this answer' }));
    });
    const save = await within(why).findByRole('button', { name: 'Save this answer' });
    expect(api.ops()).not.toContain('saveAnswer');
    await act(async () => {
      fireEvent.click(save);
    });
    expect(await within(why).findByText('Saved to your answers.')).toBeTruthy();
    expect(api.calls.at(-1)).toEqual({ op: 'saveAnswer', body: { runId: 'run_1', question: 'Why do you want to work at Example Co?', answer: 'I like small teams that ship often.' } });
    expect(within(why).queryByRole('button', { name: 'Save this answer' })).toBeNull();
  });

  it('a single-page form keeps "Fill this form" and never offers a page-by-page fill', async () => {
    const { panel } = renderPanel();
    await panel.findByText('Great fit');
    expect(panel.getByRole('button', { name: 'Fill this form' })).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Fill this page' })).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    await panel.findByText(/8 of 13 fields filled\./);
    expect(panel.queryByText("You're on a new page of this form.")).toBeNull();
  });

  it('asks whether the user submitted, and records only a Yes', async () => {
    const { panel, api } = renderPanel();
    await panel.findByText('Great fit');
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    await panel.findByText('Did you submit this application?');
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Yes, I submitted it' }));
    });
    expect(await panel.findByText('Moved to Applied in your applications.')).toBeTruthy();
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', body: { userMarkedSubmitted: true } });
  });

  it('after "Not yet", the user can still record a submission', async () => {
    const { panel, api } = renderPanel();
    await panel.findByText('Great fit');
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    await panel.findByText('Did you submit this application?');
    fireEvent.click(panel.getByRole('button', { name: 'Not yet' }));
    expect(await panel.findByText('When you submit it, mark it as applied in your applications.')).toBeTruthy();
    expect(api.calls.some((c) => c.op === 'patchRun' && (c as { body?: { userMarkedSubmitted?: boolean } }).body?.userMarkedSubmitted)).toBe(false);
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Yes, I submitted it' }));
    });
    expect(await panel.findByText('Moved to Applied in your applications.')).toBeTruthy();
    expect(api.calls.at(-1)).toMatchObject({ op: 'patchRun', body: { userMarkedSubmitted: true } });
  });

  it('labels an AI-scored fit as AI-generated on GoApply only', async () => {
    const aiFit = () => fakeApi({ pageJob: () => ({ ok: true as const, data: { jobId: 'job_1', fit: { score: 70, tier: 'good' as const, kind: 'ai' as const } } }) });
    const cn = renderPanel(aiFit(), 'cn');
    await cn.panel.findByText('70 / 100');
    expect(cn.panel.getByText('AI-generated')).toBeTruthy();
    document.body.innerHTML = '';
    const intl = renderPanel(aiFit(), 'intl');
    await intl.panel.findByText('70 / 100');
    expect(intl.panel.queryByText('AI-generated')).toBeNull();
  });

  it('Undo autofill puts fields back', async () => {
    const { panel } = renderPanel();
    await panel.findByText('Great fit');
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    await panel.findByText(/fields filled/);
    fireEvent.click(panel.getByRole('button', { name: 'Undo autofill' }));
    expect(field('#first_name').value).toBe('');
    expect(await panel.findByText(/Put back \d+ fields\./)).toBeTruthy();
  });

  it('offers to connect when the extension is not paired', async () => {
    const { panel } = renderPanel(fakeApi({ me: () => fail('not_connected', 0) }));
    const link = (await panel.findByRole('link', { name: 'Open RoboApply to connect' })) as HTMLAnchorElement;
    expect(link.href).toBe('https://www.roboapply.io/extension');
    expect(panel.queryByRole('button', { name: 'Fill this form' })).toBeNull();
  });

  it('explains when there are no credits left', async () => {
    const { panel } = renderPanel(fakeApi({ createRun: () => fail('credits_exhausted', 402, {}) }));
    await panel.findByText('Great fit');
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    expect(await panel.findByRole('alert')).toHaveProperty('textContent', "You've used your form fills for now.");
  });

  it('hides "Write a draft" when the account has no AI answers', async () => {
    const me = () => ({ ok: true as const, data: { user: { id: 'u', email: null, firstName: null }, brand: { id: 'goapply' as const, name: 'GoApply' }, entitlements: null, flags: { aiAnswers: false }, profileCompleteness: 50 } });
    const { panel, api } = renderPanel(fakeApi({ me }), 'cn');
    await panel.findByText('Great fit');
    fireEvent.click(panel.getByRole('button', { name: 'Fill this form' }));
    await panel.findByText(/fields filled/);
    expect(panel.queryByRole('button', { name: 'Write a draft' })).toBeNull();
    expect(api.ops()).not.toContain('answer');
  });
});

describe('mountPanel', () => {
  it('mounts in a shadow root with the brand on the host and starts as the launcher', async () => {
    loadFixture('greenhouse', 'classic');
    const api = fakeApi();
    const mounted = mountPanel(document, { adapter: greenhouseAdapter, doc: document, url: URL_GH, api: api.api, webOrigin: 'https://www.roboapply.io', market: 'intl', brand: 'roboapply', dev: true, open: false });
    expect(mounted.host.getAttribute('data-brand')).toBe('roboapply');
    const shadow = mounted.host.shadowRoot!;
    await waitFor(() => expect(shadow.querySelector('.launcher')).toBeTruthy());
    expect(shadow.querySelector('style')?.textContent).toContain('.panel');
    expect(api.calls).toHaveLength(0);
    act(() => mounted.open());
    await waitFor(() => expect(shadow.querySelector('.panel')).toBeTruthy());
    act(() => mounted.unmount());
    expect(document.getElementById('ra-ext-panel-host')).toBeNull();
  });

  it('uses a closed shadow root in store builds', () => {
    loadFixture('greenhouse', 'classic');
    const mounted = mountPanel(document, { adapter: greenhouseAdapter, doc: document, url: URL_GH, api: fakeApi().api, webOrigin: 'https://www.roboapply.io', market: 'intl', brand: 'roboapply', dev: false, open: false });
    expect(mounted.host.shadowRoot).toBeNull();
    act(() => mounted.unmount());
  });
});

void screen;
