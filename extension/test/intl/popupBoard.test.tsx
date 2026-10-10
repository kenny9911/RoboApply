// The toolbar popup on a job board (F-EXT-06 / F-EXT-09): nothing is read
// until "Check fit" or "Save job" is clicked; then the content script is
// injected (activeTab), the reader reads the job, and the popup sends only
// those fields. The fit shown is the API's (the app's scorer), with the
// plain-language note under it.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createContentController } from '../../src/content/controller';
import { Popup, type PopupDeps } from '../../src/popup/Popup';
import type { FitChip } from '../../src/shared/contract';
import type { ContentMessage, InternalMessage, StatusResponse } from '../../src/shared/messages';
import { parseIntlFixture } from './harness';

const URL_VIEW = 'https://www.linkedin.com/jobs/view/3901234567/';

function status(): StatusResponse {
  return { connected: true, needsReconnect: false, brand: 'roboapply', version: '0.1.0', webOrigin: 'https://www.roboapply.io' };
}

function setup(opts: { fit?: FitChip | null; saveOk?: boolean } = {}) {
  const doc = parseIntlFixture('boards', 'linkedin-view');
  const controller = createContentController({ doc, href: () => URL_VIEW, set: 'intl', dev: false, mount: vi.fn() });
  let injected = false;
  const sent: InternalMessage[] = [];
  const tabMessages: ContentMessage[] = [];
  const d: PopupDeps = {
    send: vi.fn(async (msg: InternalMessage) => {
      sent.push(msg);
      if (msg.type === 'status') return status();
      if (msg.type === 'api' && msg.call.op === 'pageJob') return { ok: true, data: { jobId: null, fit: opts.fit === undefined ? { score: 82, tier: 'great', kind: 'pre', topOverlap: null, topGap: null } : opts.fit } };
      if (msg.type === 'api' && msg.call.op === 'saveJob') return opts.saveOk === false ? { ok: false, code: 'rate_limited', status: 429 } : { ok: true, data: { jobId: 'j1', trackerEntryId: 't1', matched: null } };
      return { ok: true, data: null };
    }),
    activeTab: async () => ({ id: 3, url: URL_VIEW }),
    // No content script runs on a job board until the popup injects it.
    tabMessage: vi.fn(async (_id: number, msg: ContentMessage) => {
      tabMessages.push(msg);
      return injected ? (controller.handle(msg) ?? null) : null;
    }),
    inject: vi.fn(async () => {
      injected = true;
      controller.init();
      return true;
    }),
    openTab: vi.fn(),
    close: vi.fn(),
    adapterSet: 'intl',
  };
  return { d, sent, tabMessages };
}

describe('Popup on a job board', () => {
  it('opening the popup reads nothing and sends nothing about the page', async () => {
    const { d, sent } = setup();
    render(<Popup deps={d} />);
    expect(await screen.findByText('Job on LinkedIn. Nothing on this page is read until you choose an action.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check fit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save job' })).toBeTruthy();
    expect(d.inject).not.toHaveBeenCalled();
    expect(sent.filter((m) => m.type === 'api')).toEqual([]);
  });

  it('Check fit: reads the job after the click and shows the app’s fit with the note', async () => {
    const { d, sent, tabMessages } = setup();
    render(<Popup deps={d} />);
    const button = await screen.findByRole('button', { name: 'Check fit' });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.getByText(/Great fit/)).toBeTruthy());
    expect(d.inject).toHaveBeenCalledTimes(1);
    expect(tabMessages).toContainEqual({ type: 'page.read' });
    const call = sent.find((m) => m.type === 'api' && m.call.op === 'pageJob');
    expect(call).toBeTruthy();
    const body = (call as Extract<InternalMessage, { type: 'api' }>).call as unknown as { op: 'pageJob'; body: Record<string, unknown> };
    expect(Object.keys(body.body).sort()).toEqual(['company', 'descriptionText', 'location', 'title', 'url']);
    expect(body.body).toMatchObject({ url: URL_VIEW, title: 'Backend Engineer', company: 'Example Co', location: 'Austin, TX' });
    expect(JSON.stringify(body.body)).not.toMatch(/Avery/);
    expect(screen.getByText(/82 \/ 100/)).toBeTruthy();
    expect(screen.getByText(/Quick estimate/)).toBeTruthy();
    expect(screen.getByText('This is not your chance of getting hired.')).toBeTruthy();
  });

  it('Check fit with no score yet says so instead of showing a number', async () => {
    const { d } = setup({ fit: null });
    render(<Popup deps={d} />);
    const button = await screen.findByRole('button', { name: 'Check fit' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await screen.findByText('No fit for this job yet. Open it in RoboApply to see one.')).toBeTruthy();
    expect(screen.queryByText(/\/ 100/)).toBeNull();
  });

  it('Save job: sends the same job fields and says it is private', async () => {
    const { d, sent } = setup();
    render(<Popup deps={d} />);
    const button = await screen.findByRole('button', { name: 'Save job' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(await screen.findByText('Saved to your jobs. Only you can see it.')).toBeTruthy();
    const call = sent.find((m) => m.type === 'api' && m.call.op === 'saveJob') as Extract<InternalMessage, { type: 'api' }>;
    expect(call.call).toMatchObject({ op: 'saveJob', body: { title: 'Backend Engineer', company: 'Example Co' } });
    expect(sent.some((m) => m.type === 'api' && m.call.op === 'pageJob')).toBe(false);
  });

  // R3 (INT): until the controller's page.read uses boardPageJob(href, doc),
  // a search page sends its full URL. Then: setup with href
  // https://www.linkedin.com/jobs/search/?currentJobId=3912345678&keywords=data%20analyst
  // and expect body.url === 'https://www.linkedin.com/jobs/view/3912345678/'.
  it.todo('R3: Check fit on a LinkedIn search page sends the job’s own URL, never the search terms');
});

describe('Popup on a supported form site with no form open', () => {
  // R7 (INT): the popup should use intlFormSiteForUrl() so a Workday job
  // description page (https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123)
  // says to open the application form, and never offers "Request this site".
  it.todo('R7: Workday job description page shows the open-the-form state, not Request this site');
});
