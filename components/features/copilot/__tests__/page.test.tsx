// /assistant full page and Settings → Assistant (WP-51; F-ORION-01, F-ORION-09).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import AssistantRoute from '../../../../app/(auth)/assistant/page';
import { SettingsSection } from '../SettingsSection';
import { __resetAssistantAvailability } from '../../../../hooks/copilot';
import { CONSENTS, CREDITS, MEMORY_CONSENT, PROFILES, UI_STATE, installFetch, installPopupGate, ok, renderUi, sse, streamResponse, type Route } from './testkit';

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), push: vi.fn() }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return {
    ...real,
    usePathname: () => '/assistant',
    useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
    useSearchParams: () => nav.params,
  };
});
vi.mock('../../tailor', () => ({ TailorButton: () => null }));

const T = '/api/v1/roboapply/copilot/threads';

function routes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    'GET /api/v1/roboapply/ui-state': () => ok(UI_STATE()),
    'GET /api/v1/roboapply/credits': () => ok(CREDITS()),
    'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES()),
    [`GET ${T}`]: () => ok({ items: [{ id: 'th_9', title: 'Pay questions', contextJobId: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }] }),
    [`GET ${T}/th_9/messages`]: () => ok({ items: [{ id: 'm1', role: 'assistant', content: 'Saved answer.', cards: [], createdAt: '2026-10-09T00:00:00.000Z', feedback: null }] }),
    ...extra,
  };
}

beforeEach(() => {
  nav.params = new URLSearchParams();
  __resetAssistantAvailability();
  installPopupGate();
});
afterEach(() => vi.unstubAllGlobals());

describe('/assistant', () => {
  it('shows the saved chats and an empty conversation with the cheatsheet', async () => {
    installFetch(routes());
    renderUi(<AssistantRoute />);
    expect(await screen.findByTestId('assistant-page')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('RoboApply Assistant');
    expect(await screen.findByRole('button', { name: /^Pay questions/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('assistant-cheatsheet').length).toBeGreaterThan(0);
  });

  it('?thread= opens a saved chat', async () => {
    nav.params = new URLSearchParams('thread=th_9');
    installFetch(routes());
    renderUi(<AssistantRoute />);
    expect(await screen.findByText('Saved answer.')).toBeInTheDocument();
  });

  it('?job= starts a chat about the job with the chips and sends the job context', async () => {
    nav.params = new URLSearchParams('job=job_7');
    const http = installFetch(
      routes({
        [`POST ${T}`]: () => ok({ id: 'th_1', title: null, contextJobId: 'job_7', createdAt: 'x', updatedAt: 'x' }),
        [`POST ${T}/th_1/messages`]: (c) => streamResponse([sse('done', { messageId: 'm', usage: {}, creditsRemaining: 1 })], { signal: c.signal }),
      }),
    );
    renderUi(<AssistantRoute />);
    const chips = await screen.findByRole('group', { name: 'Quick questions about this job' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Similar jobs' }));
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(1));
    expect(http.to('POST', T)[0].body).toEqual({ contextJobId: 'job_7' });
    expect(http.to('POST', `${T}/th_1/messages`)[0].body).toMatchObject({ chip: 'similar_jobs', contextJobId: 'job_7' });
    // WP-50 answers 422 without one Idempotency-Key per turn (Wave 4 gate).
    expect(http.to('POST', `${T}/th_1/messages`)[0].headers['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('with the capability off it says the Assistant is not available and calls nothing', () => {
    const http = installFetch(routes());
    renderUi(<AssistantRoute />, { flags: { copilot: false } });
    expect(screen.getByText('The Assistant is not available here.')).toBeInTheDocument();
    expect(http.calls.filter((c) => c.path.includes('/copilot'))).toHaveLength(0);
  });

  it('GoApply with the AI consent off says so, links to the privacy settings and calls no Assistant API', async () => {
    const http = installFetch(routes({ 'GET /api/v1/roboapply/compliance/consents': () => ok(CONSENTS(false)) }));
    renderUi(<AssistantRoute />, { brand: 'goapply' });
    expect(await screen.findByTestId('assistant-unavailable')).toHaveTextContent('AI processing is off for your account');
    expect(screen.getByRole('link', { name: 'Open privacy settings' })).toHaveAttribute('href', '/settings#consents');
    expect(screen.queryByTestId('assistant-input')).not.toBeInTheDocument();
    expect(http.calls.filter((c) => c.path.includes('/copilot'))).toHaveLength(0);
  });

  it('GoApply renders nothing while the AI consent is unknown, then the workspace once it is on', async () => {
    let answer: (r: Response) => void = () => undefined;
    installFetch(routes({ 'GET /api/v1/roboapply/compliance/consents': () => new Promise<Response>((r) => (answer = r)) }));
    renderUi(<AssistantRoute />, { brand: 'goapply' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('assistant-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-unavailable')).not.toBeInTheDocument();
    answer(ok(CONSENTS(true)));
    expect(await screen.findByTestId('assistant-input')).toBeInTheDocument();
  });
});

describe('Settings → Assistant', () => {
  const FACTS = {
    items: [
      { id: 'f1', fact: 'Prefers remote jobs.', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'f2', fact: 'Wants to move into product analytics.', createdAt: '2026-10-02T00:00:00.000Z' },
    ],
  };

  it('lists what the Assistant remembers and deletes a fact', async () => {
    let items = [...FACTS.items];
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/copilot/memory': () => ok({ items }),
        'DELETE /api/v1/roboapply/copilot/memory/f1': () => {
          items = items.filter((f) => f.id !== 'f1');
          return ok(null);
        },
      }),
    );
    renderUi(<SettingsSection section="assistant" />);
    expect(await screen.findByText('Prefers remote jobs.')).toBeInTheDocument();
    expect(screen.getByText('2 of 50 saved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete: Prefers remote jobs.' }));
    await waitFor(() => expect(screen.queryByText('Prefers remote jobs.')).not.toBeInTheDocument());
    expect(http.to('DELETE', '/api/v1/roboapply/copilot/memory/f1')).toHaveLength(1);
    // RoboApply needs no memory consent.
    expect(screen.queryByTestId('assistant-memory-consent')).not.toBeInTheDocument();
  });

  it('GoApply shows the copilot_memory consent and asks before memory is on', async () => {
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/copilot/memory': () => ok({ items: [] }),
        'GET /api/v1/roboapply/compliance/consents': () => ok(MEMORY_CONSENT(null)),
        'POST /api/v1/roboapply/compliance/consents': () => ok({ type: 'copilot_memory', granted: true, proseVersion: 'v1', proseHash: 'h1' }),
      }),
    );
    renderUi(<SettingsSection section="assistant" />, { brand: 'goapply' });
    const box = await screen.findByTestId('assistant-memory-consent');
    expect(box).toHaveAttribute('data-state', 'off');
    expect(within(box).getByText('Memory is off. Nothing is saved until you turn it on.')).toBeInTheDocument();
    fireEvent.click(await within(box).findByRole('button', { name: 'Turn on memory' }));
    await waitFor(() => expect(http.to('POST', '/api/v1/roboapply/compliance/consents')).toHaveLength(1));
    expect(http.to('POST', '/api/v1/roboapply/compliance/consents')[0].body).toMatchObject({ type: 'copilot_memory', granted: true, proseVersion: 'v1' });
  });

  it('shows the floating button again after it was hidden', async () => {
    const http = installFetch(
      routes({
        'GET /api/v1/roboapply/copilot/memory': () => ok({ items: [] }),
        'GET /api/v1/roboapply/ui-state': () => ok(UI_STATE({}, { 'assistant.fab': { count: 1, at: '2026-10-09T00:00:00.000Z' } })),
        'PATCH /api/v1/roboapply/ui-state': () => ok(UI_STATE()),
      }),
    );
    renderUi(<SettingsSection section="assistant" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show it' }));
    await waitFor(() => expect(http.to('PATCH', '/api/v1/roboapply/ui-state')[0]?.body).toEqual({ undismiss: ['assistant.fab'] }));
  });

  it('renders nothing with the capability off', () => {
    installFetch(routes());
    const { container } = renderUi(<SettingsSection section="assistant" />, { flags: { copilot: false } });
    expect(container).toBeEmptyDOMElement();
  });
});
