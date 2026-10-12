// The Assistant rail and conversation (WP-51; F-ORION-01, -02, -06, -08, -10):
// opens only on an explicit action (never on route change), remembers its
// state once per load on a wide screen, Cmd/Ctrl+J, focus trap, the phone
// layout, streaming with Stop / errors / Try again, per-job chips, the
// cheatsheet, feedback, one nudge per session, saved chats, and the GoApply
// AI label. No network: fetch is a double.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CopilotRail, isEditingField, isRailShortcut, jobIdOnPage } from '../CopilotRail';
import { __assistantRailStore, openAssistantRail } from '../../../../hooks/shared/useOpenAssistant';
import { __outOfCreditsStore } from '../../../../hooks/shared/useCreditGate';
import { NUDGE_KINDS, __resetAssistantAvailability, __resetNudges, offerAssistantNudge } from '../../../../hooks/copilot';
import { NUDGE_KINDS as SERVER_NUDGE_KINDS } from '../../../../server/src/features/copilot/contract';
import { CHEATSHEET_EXTRA, cheatsheetExtra } from '../Cheatsheet';
import { CONSENTS, CREDITS, PROFILES, UI_STATE, fail, installFetch, installPopupGate, ok, renderUi, sse, streamResponse, type Route } from './testkit';

const nav = vi.hoisted(() => ({ pathname: '/jobs', push: vi.fn() }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return {
    ...real,
    usePathname: () => nav.pathname,
    useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});
// Stop also names the thread to the server (hooks/copilot/stopTurn.ts; its own test covers the call).
const stopSpy = vi.hoisted(() => ({ requestStopTurn: vi.fn(async (_threadId: string | null | undefined) => true) }));
vi.mock('../../../../hooks/copilot/stopTurn', () => stopSpy);
vi.mock('../../tailor', () => ({
  TailorButton: (p: { jobId: string; from?: string; className?: string }) => (
    <button type="button" className={p.className} data-testid="tailor-button" data-job={p.jobId} data-from={p.from}>
      Tailor resume
    </button>
  ),
}));

const T = '/api/v1/roboapply/copilot/threads';
const THREAD = { id: 'th_1', title: null, contextJobId: null, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z' };
const ANSWER =
  sse('meta', { threadId: 'th_1', messageId: 'msg_1' }) +
  sse('delta', { text: 'Your SQL work lines up with the post.' }) +
  sse('done', { messageId: 'msg_1', usage: { inputTokens: 1, outputTokens: 1 }, creditsRemaining: 11 });

let wide = true;
function setViewport(width: number) {
  wide = width > 760;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(min-width: 761px)' ? wide : query === '(max-width: 760px)' ? !wide : false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function routes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    'GET /api/v1/roboapply/ui-state': () => ok(UI_STATE()),
    'PATCH /api/v1/roboapply/ui-state': (c) => ok(UI_STATE((c.body as { values?: Record<string, string> })?.values ?? {})),
    'GET /api/v1/roboapply/credits': () => ok(CREDITS()),
    'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES()),
    [`GET ${T}`]: () => ok({ items: [] }),
    [`POST ${T}`]: () => ok(THREAD),
    [`POST ${T}/th_1/messages`]: (c) => streamResponse([ANSWER], { signal: c.signal }),
    ...extra,
  };
}

const openRail = (req: Parameters<typeof openAssistantRail>[0] = {}) => act(() => openAssistantRail(req));
const input = () => screen.getByTestId('assistant-input') as HTMLTextAreaElement;
async function ask(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

beforeEach(() => {
  __assistantRailStore.reset();
  __outOfCreditsStore.reset();
  __resetNudges();
  __resetAssistantAvailability();
  nav.pathname = '/jobs';
  nav.push.mockReset();
  setViewport(1280);
  installPopupGate();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('opening and closing', () => {
  it('renders nothing and calls nothing with the copilot capability off', () => {
    const http = installFetch(routes());
    const { container } = renderUi(<CopilotRail />, { flags: { copilot: false } });
    openRail();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(http.calls.filter((c) => c.path.includes('/copilot'))).toHaveLength(0);
  });

  it('never opens on route change', async () => {
    const http = installFetch(routes());
    const view = renderUi(<CopilotRail />);
    await waitFor(() => expect(http.to('GET', '/api/v1/roboapply/ui-state')).toHaveLength(1));
    for (const p of ['/jobs/job_1', '/applications', '/resume']) {
      nav.pathname = p;
      view.rerender(<CopilotRail />);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(__assistantRailStore.get().open).toBe(false);
  });

  it('a rail left open is not reopened by a page load: no dialog and no scrim the user did not ask for (verification finding)', async () => {
    // What an older build stored when the rail was left open.
    const http = installFetch(routes({ 'GET /api/v1/roboapply/ui-state': () => ok(UI_STATE({ 'assistant.rail': 'open' })) }));
    const { container } = renderUi(<CopilotRail />);
    await waitFor(() => expect(http.to('GET', '/api/v1/roboapply/ui-state')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.ownerDocument.querySelector('[aria-hidden="true"][class*="scrim"]')).toBeNull();
    expect(__assistantRailStore.get().open).toBe(false);
    // It still opens the moment the user asks.
    openRail();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opening and closing the rail writes nothing to ui-state (there is nothing to restore)', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(http.to('PATCH', '/api/v1/roboapply/ui-state')).toHaveLength(0);
  });

  it('Cmd/Ctrl+J toggles the rail where Ask is offered', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    installFetch(routes());
    renderUi(<CopilotRail />);
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'J', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(isRailShortcut({ key: 'j', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false })).toBe(false);
  });

  it('Cmd/Ctrl+J does nothing where the Assistant is off (copilot flag off)', async () => {
    installFetch(routes());
    renderUi(<CopilotRail />, { flags: { copilot: false } });
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the floating button opens the rail; hidden once dismissed or where the Assistant is off', async () => {
    installFetch(routes());
    const a = renderUi(<CopilotRail />, { flags: { copilot: false } });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('assistant-fab')).not.toBeInTheDocument();
    a.unmount();

    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    fireEvent.click(await screen.findByTestId('assistant-fab'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide the floating button' }));
    await waitFor(() => expect(http.to('PATCH', '/api/v1/roboapply/ui-state').map((c) => c.body)).toContainEqual({ dismiss: ['assistant.fab'] }));
  });

  it('keeps focus inside the rail (Tab wraps) and Escape closes it, returning focus', async () => {
    installFetch(routes());
    renderUi(
      <>
        <button type="button">Outside</button>
        <CopilotRail />
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    openRail();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    const focusables = dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(outside);
  });

  it('on a 375px phone the rail is the full-screen drawer, and leaving for a page closes it', async () => {
    setViewport(375);
    installFetch(routes());
    renderUi(<CopilotRail />);
    openRail({ jobId: 'job_1' });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-testid', 'drawer');
    // The drawer primitive goes edge to edge below 760px.
    const css = readFileSync(join(process.cwd(), 'components/v3/primitives/primitives.module.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 760px\)\s*{\s*\.drawerRight,[\s\S]*?width: 100vw/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Practice for this job' }));
    expect(nav.push).toHaveBeenCalledWith('/practice?job=job_1&from=assistant');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('conversation', () => {
  it('sends on Enter, creates the thread, streams the answer with the brand symbol (no persona name)', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Which jobs fit me?');
    expect(await screen.findByText('Your SQL work lines up with the post.')).toBeInTheDocument();
    expect(http.to('POST', T)[0].body).toEqual({});
    expect(http.to('POST', `${T}/th_1/messages`)[0].body).toEqual({ text: 'Which jobs fit me?' });
    const answer = document.querySelector('[data-role="assistant"]') as HTMLElement;
    expect(within(answer).getByTestId('assistant-avatar')).toBeInTheDocument();
    expect(answer.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    // RoboApply: no GoApply AI badge; feedback appears once saved.
    expect(answer.querySelector('[data-ai-label]')).toBeNull();
    expect(within(answer).getByRole('button', { name: 'Helpful' })).toBeInTheDocument();
    expect(input().value).toBe('');
  });

  it('GoApply answers carry the AI generated badge', async () => {
    installFetch(routes({ 'GET /api/v1/roboapply/compliance/consents': () => ok(CONSENTS(true)) }));
    renderUi(<CopilotRail />, { brand: 'goapply' });
    openRail();
    await screen.findByRole('dialog');
    // The composer appears once the AI consent is known to be on.
    await screen.findByTestId('assistant-input');
    await ask('你好');
    await screen.findByText('Your SQL work lines up with the post.');
    const answer = document.querySelector('[data-role="assistant"]') as HTMLElement;
    expect(answer.querySelector('[data-ai-label]')).not.toBeNull();
  });

  it('Stop ends the stream and keeps the partial answer', async () => {
    installFetch(routes({ [`POST ${T}/th_1/messages`]: (c) => streamResponse([sse('meta', { threadId: 'th_1', messageId: 'm' }), sse('delta', { text: 'Half an' })], { signal: c.signal, hold: true }) }));
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Tell me more');
    await screen.findByText('Half an');
    stopSpy.requestStopTurn.mockClear();
    fireEvent.click(screen.getByTestId('assistant-stop'));
    expect(await screen.findByText('Stopped.')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-send')).toBeInTheDocument();
    // Aborting the fetch may not reach the server through a proxy: the thread is named to it as well.
    expect(stopSpy.requestStopTurn).toHaveBeenCalledTimes(1);
    expect(stopSpy.requestStopTurn).toHaveBeenCalledWith('th_1');
  });

  it('an error event shows a plain message and Try again re-sends the question', async () => {
    let n = 0;
    const http = installFetch(
      routes({
        [`POST ${T}/th_1/messages`]: (c) => {
          n += 1;
          return n === 1
            ? streamResponse([sse('error', { code: 'llm_interrupted', message: 'x', retryable: true })], { signal: c.signal })
            : streamResponse([ANSWER], { signal: c.signal });
        },
      }),
    );
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Why?');
    expect(await screen.findByText('The answer stopped early.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('assistant-retry'));
    await screen.findByText('Your SQL work lines up with the post.');
    expect(http.to('POST', `${T}/th_1/messages`).map((c) => c.body)).toEqual([{ text: 'Why?' }, { text: 'Why?' }]);
    expect(screen.getAllByText('Why?')).toHaveLength(1);
  });

  it('the guarded reply in done.content replaces what streamed', async () => {
    const guarded =
      sse('meta', { threadId: 'th_1', messageId: 'msg_1' }) +
      sse('delta', { text: 'It pays $250,000 a year.' }) +
      sse('done', { messageId: 'msg_1', usage: { inputTokens: 1, outputTokens: 1 }, creditsRemaining: 11, content: 'No source found for that number.', guarded: true });
    installFetch(routes({ [`POST ${T}/th_1/messages`]: (c) => streamResponse([guarded], { signal: c.signal }) }));
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('What does it pay?');
    expect(await screen.findByText('No source found for that number.')).toBeInTheDocument();
    expect(screen.queryByText(/\$250,000/)).not.toBeInTheDocument();
  });

  it('save_failed (the reply was not stored, no done follows): says it used no message and Try again re-sends', async () => {
    let n = 0;
    const http = installFetch(
      routes({
        [`POST ${T}/th_1/messages`]: (c) => {
          n += 1;
          return n === 1
            ? streamResponse([sse('delta', { text: 'Half an answer.' }), sse('error', { code: 'save_failed', message: 'The reply could not be saved. Try again.', retryable: true })], { signal: c.signal })
            : streamResponse([ANSWER], { signal: c.signal });
        },
      }),
    );
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Why?');
    expect(await screen.findByText('This answer could not be saved, so it did not use a message. Try again.')).toBeInTheDocument();
    // No thumbs on an answer that was never stored.
    expect(screen.queryByRole('button', { name: 'Helpful' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('assistant-retry'));
    await screen.findByText('Your SQL work lines up with the post.');
    expect(screen.queryByText('Half an answer.')).not.toBeInTheDocument();
    expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(2);
    // A retry is a new intent: its own Idempotency-Key.
    const keys = http.to('POST', `${T}/th_1/messages`).map((c) => c.headers['Idempotency-Key']);
    expect(new Set(keys).size).toBe(2);
  });

  it('a 402 before streaming opens the out-of-credits sheet and says so', async () => {
    installFetch(routes({ [`POST ${T}/th_1/messages`]: () => fail(402, 'credits_exhausted', { bucket: 'assistant', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true }) }));
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Hi');
    expect(await screen.findByText('No Assistant messages left today.')).toBeInTheDocument();
    expect(__outOfCreditsStore.get()).toMatchObject({ bucket: 'assistant', upgradable: true });
    expect(screen.queryByTestId('assistant-retry')).not.toBeInTheDocument();
  });

  it('a busy budget says nothing was charged', async () => {
    installFetch(routes({ [`POST ${T}/th_1/messages`]: () => fail(503, 'copilot_budget_exhausted') }));
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Hi');
    expect(await screen.findByText('The Assistant is busy right now. Try again later. Nothing was charged.')).toBeInTheDocument();
  });

  it('thumbs down asks for a reason and sends it', async () => {
    const http = installFetch(routes({ 'POST /api/v1/roboapply/copilot/messages/msg_1/feedback': () => ok(null) }));
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Hi');
    fireEvent.click(await screen.findByRole('button', { name: 'Not helpful' }));
    fireEvent.click(screen.getByLabelText('Too long'));
    fireEvent.change(screen.getByLabelText('Anything to add? (optional)'), { target: { value: 'Shorter please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    await screen.findByText('Thanks for the feedback.');
    expect(http.to('POST', '/api/v1/roboapply/copilot/messages/msg_1/feedback')[0].body).toEqual({ value: 'down', note: 'tooLong: Shorter please' });
  });

  it('shows the credit line for a message', async () => {
    installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    expect(await screen.findByText('Uses 1 of your 12 left today')).toBeInTheDocument();
  });
});

describe('per-job chips (F-ORION-02)', () => {
  it('"Ask about this job" starts a chat about the job with the seven quick actions', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail({ jobId: 'job_1', source: 'job_detail' });
    const dialog = await screen.findByRole('dialog');
    const group = within(dialog).getByRole('group', { name: 'Quick questions about this job' });
    for (const name of ['Why I fit', "What I'm missing", 'Resume tips', 'Write a cover letter', 'Practice for this job', 'Similar jobs']) {
      expect(within(group).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(group).getByTestId('tailor-button')).toHaveAttribute('data-from', 'assistant');
    fireEvent.click(within(group).getByRole('button', { name: 'Why I fit' }));
    await screen.findByText('Your SQL work lines up with the post.');
    expect(http.to('POST', T)[0].body).toEqual({ contextJobId: 'job_1' });
    expect(http.to('POST', `${T}/th_1/messages`)[0].body).toEqual({ text: 'Why do I fit this job?', chip: 'why_fit', contextJobId: 'job_1' });
  });
});

describe('resume scope (F-RES-11)', () => {
  it('"Ask about this resume" starts a chat scoped to that resume and sends resumeId with every turn', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail({ source: 'resume', scope: 'resume', resumeId: 'res_7', prompt: 'How can I improve this resume?' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('assistant-resume-scope')).toHaveTextContent('About this resume');
    // The prompt is in the box, unsent; no job chips for a resume chat.
    await waitFor(() => expect(input().value).toBe('How can I improve this resume?'));
    expect(within(dialog).queryByRole('group', { name: 'Quick questions about this job' })).not.toBeInTheDocument();
    expect(http.to('POST', T)).toHaveLength(0);

    fireEvent.keyDown(input(), { key: 'Enter' });
    await screen.findByText('Your SQL work lines up with the post.');
    // The thread has no job context; the turn carries the resume.
    expect(http.to('POST', T)[0].body).toEqual({});
    expect(http.to('POST', `${T}/th_1/messages`)[0].body).toEqual({ text: 'How can I improve this resume?', resumeId: 'res_7' });
    await ask('Shorten the summary.');
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(2));
    expect(http.to('POST', `${T}/th_1/messages`)[1].body).toEqual({ text: 'Shorten the summary.', resumeId: 'res_7' });
  });

  it('asking about another resume starts a new chat for it; a job request then drops the resume scope', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail({ scope: 'resume', resumeId: 'res_7' });
    await screen.findByRole('dialog');
    await ask('Tips?');
    await screen.findByText('Your SQL work lines up with the post.');

    openRail({ scope: 'resume', resumeId: 'res_8' });
    await waitFor(() => expect(screen.queryByText('Your SQL work lines up with the post.')).not.toBeInTheDocument());
    await ask('And this one?');
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(2));
    expect(http.to('POST', `${T}/th_1/messages`)[1].body).toEqual({ text: 'And this one?', resumeId: 'res_8' });

    openRail({ jobId: 'job_1', source: 'job_detail' });
    await waitFor(() => expect(screen.queryByTestId('assistant-resume-scope')).not.toBeInTheDocument());
    await ask('Why do I fit?');
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(3));
    expect(http.to('POST', `${T}/th_1/messages`)[2].body).toEqual({ text: 'Why do I fit?', contextJobId: 'job_1' });
  });

  it('a resumeId without scope "resume" is not a resume chat (the scope is explicit)', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail({ resumeId: 'res_7' });
    await screen.findByRole('dialog');
    expect(screen.queryByTestId('assistant-resume-scope')).not.toBeInTheDocument();
    await ask('Hi');
    await screen.findByText('Your SQL work lines up with the post.');
    expect(http.to('POST', `${T}/th_1/messages`)[0].body).toEqual({ text: 'Hi' });
  });
});

describe('cheatsheet (F-ORION-06)', () => {
  it('offers the sort question again (the feed honours /jobs?sort=)', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByTestId('assistant-cheatsheet-toggle'));
    const sheet = screen.getByTestId('assistant-cheatsheet');
    expect(CHEATSHEET_EXTRA.find).toEqual(['sort']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show the newest jobs first.' }));
    expect(input().value).toBe('Show the newest jobs first.');
    expect(http.to('POST', T)).toHaveLength(0);
  });

  it('the sort question follows the one switch for the sort link: with it off the question is not offered', () => {
    expect(cheatsheetExtra('find')).toEqual(['sort']);
    expect(cheatsheetExtra('find', { sortLink: false })).toEqual([]);
    expect(cheatsheetExtra('search', { sortLink: true })).toEqual([]);
  });

  it('has six groups; picking a question fills the box and sends nothing', async () => {
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByTestId('assistant-cheatsheet-toggle'));
    const sheet = screen.getByTestId('assistant-cheatsheet');
    expect(within(sheet).getAllByRole('heading', { level: 4 })).toHaveLength(6);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Summarize my applications.' }));
    expect(input().value).toBe('Summarize my applications.');
    expect(http.to('POST', T)).toHaveLength(0);
  });
});

describe('saved chats', () => {
  it('Chats lists threads; opening one loads its messages', async () => {
    installFetch(
      routes({
        [`GET ${T}`]: () => ok({ items: [{ ...THREAD, id: 'th_old', title: 'Remote data jobs' }] }),
        [`GET ${T}/th_old/messages`]: () =>
          ok({
            items: [
              { id: 'm2', role: 'assistant', content: 'Here are three.', cards: [], createdAt: '2026-10-09T10:00:01.000Z', feedback: null },
              { id: 'm1', role: 'user', content: 'Remote data jobs?', cards: [], createdAt: '2026-10-09T10:00:00.000Z', feedback: null },
            ],
          }),
      }),
    );
    renderUi(<CopilotRail />);
    openRail();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Chats' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Remote data jobs/ }));
    expect(await screen.findByText('Here are three.')).toBeInTheDocument();
    const roles = Array.from(document.querySelectorAll('[data-role]')).map((el) => el.getAttribute('data-role'));
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('New chat clears the conversation', async () => {
    installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    await screen.findByRole('dialog');
    await ask('Hi');
    await screen.findByText('Your SQL work lines up with the post.');
    fireEvent.click(screen.getByTestId('assistant-new-chat'));
    expect(screen.queryByText('Your SQL work lines up with the post.')).not.toBeInTheDocument();
  });
});

describe('proactive nudge (F-ORION-08)', () => {
  it('shows one nudge; Ask opens the rail with the question in the box, unsent', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    await screen.findByTestId('assistant-fab');
    act(() => {
      offerAssistantNudge({ kind: 'pay_filter' });
    });
    const bubble = await screen.findByTestId('assistant-nudge');
    expect(bubble).toHaveTextContent('Many jobs list their pay. Add a minimum pay to your search?');
    fireEvent.click(within(bubble).getByRole('button', { name: 'Ask the Assistant' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(input().value).toBe('Add a minimum pay to my search.'));
    expect(http.to('POST', T)).toHaveLength(0);
    expect(offerAssistantNudge({ kind: 'low_rating' })).toBe(false);
  });

  const NUDGE = '/api/v1/roboapply/copilot/nudge';
  /** What GET /copilot/nudge answers: the kind, the server's debug English prompt and the facts behind it. */
  const nudge = (kind: string) => ok({ nudge: { kind, prompt: `DEBUG ONLY: server prompt for ${kind}`, facts: { searchProfileId: 'sp_main' } } });

  it('the kinds are the server\'s (one vocabulary on both sides)', () => {
    expect([...NUDGE_KINDS].sort()).toEqual([...SERVER_NUDGE_KINDS].sort());
  });

  it('asks the server on mount and shows the nudge it derived; the server prompt is never shown or put in the box', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    const http = installFetch(routes({ [`GET ${NUDGE}`]: () => nudge('agency_report') }));
    renderUi(<CopilotRail />);
    const bubble = await screen.findByTestId('assistant-nudge');
    expect(http.to('GET', NUDGE)).toHaveLength(1);
    // The chip label is assistant.nudge.<kind>.
    expect(bubble).toHaveTextContent('Hide posts from staffing agencies?');
    expect(document.body.textContent).not.toContain('DEBUG ONLY');

    fireEvent.click(within(bubble).getByRole('button', { name: 'Ask the Assistant' }));
    await screen.findByRole('dialog');
    // The composer text is assistant.nudge.prompts.<kind>; nothing is sent until the user presses Send.
    await waitFor(() => expect(input().value).toBe('Hide posts from staffing agencies in my search.'));
    expect(input().value).not.toContain('DEBUG ONLY');
    expect(http.to('POST', T)).toHaveLength(0);
    expect(http.calls.some((c) => JSON.stringify(c.body ?? '').includes('DEBUG ONLY'))).toBe(false);
  });

  it.each([...SERVER_NUDGE_KINDS])('every server kind has its label and its composer text: %s', async (kind) => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    installFetch(routes({ [`GET ${NUDGE}`]: () => nudge(kind) }));
    renderUi(<CopilotRail />, kind === 'campus_deadline' ? { brand: 'goapply', flags: { 'ai.text': true } } : {});
    if (kind === 'campus_deadline') return; // GoApply needs the AI consent before any Ask entry shows; covered below.
    const bubble = await screen.findByTestId('assistant-nudge');
    expect(bubble.textContent).not.toMatch(/assistant\.nudge|nudge\./);
    fireEvent.click(within(bubble).getByRole('button', { name: 'Ask the Assistant' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(input().value.length).toBeGreaterThan(10));
    expect(input().value).not.toMatch(/nudge\.prompts|DEBUG/);
  });

  it('asks again when the route changes, while a nudge could still be shown', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    let answer: () => Response = () => ok({ nudge: null });
    const http = installFetch(routes({ [`GET ${NUDGE}`]: () => answer() }));
    const view = renderUi(<CopilotRail />);
    await waitFor(() => expect(http.to('GET', NUDGE)).toHaveLength(1));
    expect(screen.queryByTestId('assistant-nudge')).not.toBeInTheDocument();

    // The user rated the feed low; on the next page the server has a signal.
    answer = () => nudge('low_rating');
    nav.pathname = '/applications';
    view.rerender(<CopilotRail />);
    const bubble = await screen.findByTestId('assistant-nudge');
    expect(http.to('GET', NUDGE)).toHaveLength(2);
    expect(bubble).toHaveTextContent('Recent jobs were not a good fit. Adjust your search?');

    // One nudge per session: later routes do not ask again.
    fireEvent.click(within(bubble).getByRole('button', { name: 'Not now' }));
    nav.pathname = '/resume';
    view.rerender(<CopilotRail />);
    await new Promise((r) => setTimeout(r, 20));
    expect(http.to('GET', NUDGE)).toHaveLength(2);
    expect(screen.queryByTestId('assistant-nudge')).not.toBeInTheDocument();
  });

  it('no signal, an unknown kind or a failed call shows nothing (a nudge is never invented)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    for (const route of [() => ok({ nudge: null }), () => nudge('upgrade_now'), () => fail(500, 'server_error')]) {
      __resetNudges();
      const http = installFetch(routes({ [`GET ${NUDGE}`]: route }));
      const view = renderUi(<CopilotRail />);
      await screen.findByTestId('assistant-fab');
      await waitFor(() => expect(http.to('GET', NUDGE)).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(screen.queryByTestId('assistant-nudge')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('does not ask where no nudge could be shown: before Ask is offered, or on /assistant', async () => {
    // Where the Assistant is off (copilot flag off, no floating button): no call.
    const hidden = installFetch(routes({ [`GET ${NUDGE}`]: () => nudge('pay_filter') }));
    const a = renderUi(<CopilotRail />, { flags: { copilot: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden.to('GET', NUDGE)).toHaveLength(0);
    a.unmount();

    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    nav.pathname = '/assistant';
    const page = installFetch(routes({ [`GET ${NUDGE}`]: () => nudge('pay_filter') }));
    const b = renderUi(<CopilotRail />);
    await new Promise((r) => setTimeout(r, 20));
    expect(page.to('GET', NUDGE)).toHaveLength(0);
    expect(screen.queryByTestId('assistant-nudge')).not.toBeInTheDocument();
    b.unmount();
  });

  it('GoApply without the AI consent: no nudge call and no nudge', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    const http = installFetch(routes({ 'GET /api/v1/roboapply/compliance/consents': () => ok(CONSENTS(false)), [`GET ${NUDGE}`]: () => nudge('campus_deadline') }));
    renderUi(<CopilotRail />, { brand: 'goapply' });
    await waitFor(() => expect(http.to('GET', '/api/v1/roboapply/compliance/consents').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(http.to('GET', NUDGE)).toHaveLength(0);
    expect(screen.queryByTestId('assistant-nudge')).not.toBeInTheDocument();
  });

  it('GoApply with the AI consent: a followed campus deadline is offered in the campus words', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    const http = installFetch(routes({ 'GET /api/v1/roboapply/compliance/consents': () => ok(CONSENTS(true)), [`GET ${NUDGE}`]: () => nudge('campus_deadline') }));
    renderUi(<CopilotRail />, { brand: 'goapply' });
    const bubble = await screen.findByTestId('assistant-nudge');
    expect(http.to('GET', NUDGE)).toHaveLength(1);
    expect(bubble).toHaveTextContent('Some application deadlines you follow close soon. Check them?');
  });
});

describe('AI availability (aiAllowed; TASK_PLAN §2.2)', () => {
  const CONSENTS_PATH = 'GET /api/v1/roboapply/compliance/consents';

  it('GoApply without the AI consent: no floating button, Cmd/Ctrl+J does nothing, an open request is closed, nothing is sent', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    const http = installFetch(routes({ [CONSENTS_PATH]: () => ok(CONSENTS(false)) }));
    renderUi(<CopilotRail />, { brand: 'goapply' });
    await waitFor(() => expect(http.to('GET', '/api/v1/roboapply/compliance/consents')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('assistant-fab')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Another area's Ask (gated on the capability only) reaches the rail: it is closed again.
    openRail({ jobId: 'job_1' });
    await waitFor(() => expect(__assistantRailStore.get().open).toBe(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(http.calls.filter((c) => c.method === 'POST' && c.path.includes('/copilot'))).toHaveLength(0);
  });

  it('GoApply while the consent is still unknown: fails closed (no floating button, no composer)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    installFetch(routes({ [CONSENTS_PATH]: () => new Promise<Response>(() => undefined) }));
    renderUi(<CopilotRail />, { brand: 'goapply' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('assistant-fab')).not.toBeInTheDocument();
    openRail({ jobId: 'job_1' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('assistant-input')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Quick questions about this job' })).not.toBeInTheDocument();
  });

  it('GoApply with the AI consent shows the floating button', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    installFetch(routes({ [CONSENTS_PATH]: () => ok(CONSENTS(true)) }));
    renderUi(<CopilotRail />, { brand: 'goapply' });
    expect(await screen.findByTestId('assistant-fab')).toBeInTheDocument();
  });

  it('a turn that ends in ai_unavailable hides the composer, chips and floating button for the session', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    installFetch(
      routes({
        [`POST ${T}/th_1/messages`]: (c) => streamResponse([sse('error', { code: 'ai_unavailable', message: 'x', retryable: false })], { signal: c.signal }),
      }),
    );
    renderUi(<CopilotRail />);
    openRail({ jobId: 'job_1' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('group', { name: 'Quick questions about this job' })).toBeInTheDocument();
    await ask('Why?');
    expect(await within(dialog).findByTestId('assistant-cannot-ask')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('assistant-input')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Quick questions about this job' })).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('assistant-cheatsheet-toggle')).not.toBeInTheDocument();
    // The conversation so far stays readable.
    expect(within(dialog).getByText('Why?')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByTestId('assistant-fab')).not.toBeInTheDocument();
  });
});

describe('the job on screen is the job in context (verification finding: top-bar Ask on a job page had no job)', () => {
  it('Ask in the top bar on /jobs/<id> starts a chat about that job: chips show, the thread and the turn carry it', async () => {
    nav.pathname = '/jobs/job_42';
    const http = installFetch(routes());
    renderUi(<CopilotRail />);
    openRail({ source: 'topbar' });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('About this job')).toBeInTheDocument();
    // "About a job" questions are offered: there is a job for them to be about.
    expect(within(dialog).getByRole('button', { name: 'Why do I fit this job?' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Why I fit' }));
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(1));
    expect(http.to('POST', T)[0].body).toEqual({ contextJobId: 'job_42' });
    expect(http.to('POST', `${T}/th_1/messages`)[0].body).toMatchObject({ chip: 'why_fit', contextJobId: 'job_42' });
  });

  it('on a page that is not a job, the "this job" questions are not offered (they would spend a message on "which job?")', async () => {
    nav.pathname = '/jobs';
    installFetch(routes());
    renderUi(<CopilotRail />);
    openRail({ source: 'topbar' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('About this job')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Why do I fit this job?' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Tailor my resume for this job.' })).not.toBeInTheDocument();
    const hint = within(dialog).getByTestId('cheatsheet-needs-job-job');
    expect(hint).toHaveTextContent('These questions are about one job. Open a job, then ask from there.');
    expect(within(hint).getByRole('link', { name: 'Open your jobs' })).toHaveAttribute('href', '/jobs');
    // Questions that need no job stay.
    expect(within(dialog).getByRole('button', { name: 'Find jobs that list their pay.' })).toBeInTheDocument();
  });

  it('a conversation under way, then Ask on a job page: the thread offers a new chat about that job (review: the job was still missing)', async () => {
    nav.pathname = '/jobs';
    const http = installFetch(routes());
    const view = renderUi(<CopilotRail />);
    openRail({ source: 'topbar' });
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('assistant-input');
    // No job page: nothing to offer.
    await ask('Which jobs list their pay?');
    await within(dialog).findByText('Your SQL work lines up with the post.');
    expect(within(dialog).queryByTestId('assistant-page-job')).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The same session, now on a job: Ask shows the conversation, and says it is not about this job.
    nav.pathname = '/jobs/job_42';
    view.rerender(<CopilotRail />);
    openRail({ source: 'topbar' });
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Your SQL work lines up with the post.')).toBeInTheDocument();
    const offer = await within(dialog).findByTestId('assistant-page-job');
    expect(offer).toHaveTextContent('This chat is not about the job on this page.');
    // The prompt list does not send the user to open a job they are already on.
    fireEvent.click(within(dialog).getByTestId('assistant-cheatsheet-toggle'));
    const group = await within(dialog).findByTestId('cheatsheet-page-job-job');
    expect(group).toHaveTextContent('These questions are about one job. This chat is not about the job on this page.');
    expect(within(dialog).queryByTestId('cheatsheet-needs-job-job')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Open your jobs' })).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'New chat about this job' }));
    // A new chat about the job on screen: its questions and chips are there, and the turn carries the job.
    expect(await within(dialog).findByText('About this job')).toBeInTheDocument();
    expect(within(dialog).queryByText('Your SQL work lines up with the post.')).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId('assistant-page-job')).not.toBeInTheDocument();
    await ask('Why do I fit this job?');
    await waitFor(() => expect(http.to('POST', T)).toHaveLength(2));
    expect(http.to('POST', T)[1].body).toEqual({ contextJobId: 'job_42' });
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(2));
    expect(http.to('POST', `${T}/th_1/messages`)[1].body).toMatchObject({ text: 'Why do I fit this job?', contextJobId: 'job_42' });
  });

  it('a chat about one job, opened on another job: the offer above the box says so and starts a chat about the job on screen', async () => {
    nav.pathname = '/jobs/job_1';
    const http = installFetch(routes());
    const view = renderUi(<CopilotRail />);
    openRail({ source: 'topbar' });
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Why I fit' }));
    await within(dialog).findByText('Your SQL work lines up with the post.');
    // On its own job there is nothing to offer.
    expect(within(dialog).queryByTestId('assistant-page-job')).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    nav.pathname = '/jobs/job_2';
    view.rerender(<CopilotRail />);
    openRail({ source: 'topbar' });
    dialog = await screen.findByRole('dialog');
    const offer = await within(dialog).findByTestId('assistant-page-job');
    expect(offer).toHaveTextContent('This chat is about another job.');
    fireEvent.click(within(offer).getByRole('button', { name: 'New chat about this job' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Why I fit' }));
    await waitFor(() => expect(http.to('POST', T)).toHaveLength(2));
    expect(http.to('POST', T)[1].body).toEqual({ contextJobId: 'job_2' });
  });

  it('the lists (/jobs/explore, /jobs/added, /jobs/report) are not a job', () => {
    expect(jobIdOnPage('/jobs/job_42')).toBe('job_42');
    expect(jobIdOnPage('/jobs/job_42/')).toBe('job_42');
    for (const p of ['/jobs', '/jobs/explore', '/jobs/added', '/jobs/report', '/jobs/job_42/people', '/applications/job_42']) expect(jobIdOnPage(p), p).toBeNull();
  });

  it('a job left over from an earlier page is replaced by the page the user asks from; a conversation under way is not', async () => {
    nav.pathname = '/jobs/job_1';
    const http = installFetch(routes());
    const view = renderUi(<CopilotRail />);
    openRail({ source: 'topbar' });
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('About this job');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Nothing was said: on the next job the chat is about that job.
    nav.pathname = '/jobs/job_2';
    view.rerender(<CopilotRail />);
    openRail({ source: 'topbar' });
    dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Why I fit' }));
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(1));
    expect(http.to('POST', `${T}/th_1/messages`)[0].body).toMatchObject({ contextJobId: 'job_2' });
    await within(dialog).findByText('Your SQL work lines up with the post.');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // A conversation exists now: Ask from another job shows it, unchanged.
    nav.pathname = '/jobs/job_3';
    view.rerender(<CopilotRail />);
    openRail({ source: 'topbar' });
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Your SQL work lines up with the post.')).toBeInTheDocument();
    await ask('And the pay?');
    await waitFor(() => expect(http.to('POST', `${T}/th_1/messages`)).toHaveLength(2));
    expect(http.to('POST', `${T}/th_1/messages`)[1].body).toMatchObject({ contextJobId: 'job_2' });
    // "New chat" there is about the job on screen.
    fireEvent.click(within(dialog).getByTestId('assistant-new-chat'));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Why I fit' }));
    await waitFor(() => expect(http.to('POST', T)).toHaveLength(2));
    expect(http.to('POST', T)[1].body).toEqual({ contextJobId: 'job_3' });
  });
});

describe('the floating button steps aside while the user types (verification finding: it covered inputs)', () => {
  it('is hidden while a field of the page has focus and back when it is left', async () => {
    installFetch(routes());
    renderUi(
      <>
        <input aria-label="Note" />
        <button type="button">Next note</button>
        <CopilotRail />
      </>,
    );
    await screen.findByTestId('assistant-fab');
    act(() => screen.getByLabelText('Note').focus());
    await waitFor(() => expect(screen.queryByTestId('assistant-fab')).not.toBeInTheDocument());
    act(() => screen.getByRole('button', { name: 'Next note' }).focus());
    expect(await screen.findByTestId('assistant-fab')).toBeInTheDocument();
  });

  it('knows a typing field from a button or a checkbox', () => {
    const el = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstElementChild;
    };
    expect(isEditingField(el('<input />'))).toBe(true);
    expect(isEditingField(el('<input type="search" />'))).toBe(true);
    expect(isEditingField(el('<textarea></textarea>'))).toBe(true);
    expect(isEditingField(el('<select></select>'))).toBe(true);
    expect(isEditingField(el('<div contenteditable="true"></div>'))).toBe(true);
    expect(isEditingField(el('<input type="checkbox" />'))).toBe(false);
    expect(isEditingField(el('<button></button>'))).toBe(false);
    expect(isEditingField(null)).toBe(false);
  });
});

describe('the composer in the rail (verification finding: scrolled questions showed under it, the hint was cut)', () => {
  const css = readFileSync(join(process.cwd(), 'components/features/copilot/copilot.module.css'), 'utf8');

  it('reaches down over the drawer body\'s bottom padding, so nothing scrolls into view below it', () => {
    const body = /\.body\s*{[^}]*padding:\s*0 var\(--sp-5\) var\(--sp-5\)/.test(readFileSync(join(process.cwd(), 'components/v3/primitives/primitives.module.css'), 'utf8'));
    expect(body, 'the drawer body still pads its bottom by --sp-5').toBe(true);
    expect(css).toMatch(/\.thread\[data-variant='rail'\] \.composer\s*{\s*bottom: calc\(-1 \* var\(--sp-5\)\);\s*padding-bottom: var\(--sp-5\);/);
  });

  it('the thread reaches the scroller\'s edge while the composer is shown, so the space under it is the same at the end of the chat (review: a 20px jump)', async () => {
    expect(css).toMatch(/\.thread\[data-variant='rail'\]\[data-composer\]\s*{\s*min-height: calc\(100% \+ var\(--sp-5\)\);\s*margin-bottom: calc\(-1 \* var\(--sp-5\)\);/);
    installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('assistant-input');
    const thread = dialog.querySelector('[data-variant="rail"]') as HTMLElement;
    expect(thread).toHaveAttribute('data-composer');
    // The other rail views have no composer and keep the drawer's own padding.
    fireEvent.click(within(dialog).getByTestId('assistant-cheatsheet-toggle'));
    await waitFor(() => expect(within(dialog).queryByTestId('assistant-input')).not.toBeInTheDocument());
    expect(thread).not.toHaveAttribute('data-composer');
  });

  it('keeps the hint on one line (a short hint in the rail, so it is never cut) and lets the box grow with the text', async () => {
    expect(css).toMatch(/\.input::placeholder\s*{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.input\s*{\s*field-sizing: content;/);
    installFetch(routes());
    renderUi(<CopilotRail />);
    openRail();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('assistant-input')).toHaveAttribute('placeholder', 'Ask a question');
  });
});

describe('on /assistant (the full page is the Assistant)', () => {
  it('does not open the rail there, and leaving later does not open it', async () => {
    nav.pathname = '/assistant';
    const http = installFetch(routes({ 'GET /api/v1/roboapply/ui-state': () => ok(UI_STATE({ 'assistant.rail': 'open' })) }));
    const view = renderUi(<CopilotRail />);
    await waitFor(() => expect(http.to('GET', '/api/v1/roboapply/ui-state')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    nav.pathname = '/jobs';
    view.rerender(<CopilotRail />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(http.to('PATCH', '/api/v1/roboapply/ui-state')).toHaveLength(0);
  });

  it('Cmd/Ctrl+J does not open a second Assistant over the page', async () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    nav.pathname = '/assistant';
    installFetch(routes());
    renderUi(<CopilotRail />);
    const ev = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
