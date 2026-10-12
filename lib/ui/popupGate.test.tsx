// lib/ui/popupGate.ts — rule 5: a popup is its key, not one call.
//
// Verification finding: the first-visit tour never appeared. Under React
// Strict Mode the mount effect of `usePopupGate` runs twice; the first request
// won the page view's slot after its effect had been cleaned up (so the grant
// was dropped) and the second request of the SAME key was refused. The slot
// stayed spent and nothing showed. (The base rules are covered by
// __tests__/shell/popupGate.test.tsx.)

import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import { __setPopupGate, createPopupGate, getPopupGate, notePageView, usePopupGate, type PopupGateDeps } from './popupGate';

const nav = vi.hoisted(() => ({ pathname: '/jobs' as string | null }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

vi.mock('../api/uiState', () => ({
  getUiState: vi.fn(async () => ({ state: { popupLastShownAt: null }, lastFeedVisitAt: null, updatedAt: null })),
  recordPopupShown: vi.fn(async () => ({})),
}));

function harness() {
  let now = Date.parse('2026-10-10T09:00:00Z');
  const queue: (() => void)[] = [];
  const persist = vi.fn();
  const deps: PopupGateDeps = {
    now: () => now,
    loadLocal: () => null,
    saveLocal: () => undefined,
    persist,
    schedule: (fn) => {
      queue.push(fn);
    },
  };
  return {
    gate: createPopupGate(deps),
    persist,
    advance: (ms: number) => {
      now += ms;
    },
    flush: async () => {
      while (queue.length) queue.shift()!();
      await Promise.resolve();
    },
  };
}

describe('the same key asking twice is one popup', () => {
  it('grants every request of the winning key in one batch, and still refuses the other keys', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const first = h.gate.request('onboarding:tour', 'announcement', { essential: true });
    const again = h.gate.request('onboarding:tour', 'announcement', { essential: true });
    const other = h.gate.request('assistant:nudge', 'announcement', { essential: true });
    await h.flush();
    expect(await Promise.all([first, again, other])).toEqual([true, true, false]);
    expect(h.gate.snapshot().shownThisView).toBe('onboarding:tour');
  });

  it('grants the key that holds the slot when it asks again later in the view, without a second 24 h stamp', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const first = h.gate.request('feed:afterChange', 'survey');
    await h.flush();
    expect(await first).toBe(true);
    expect(h.persist).toHaveBeenCalledTimes(1);
    const stamped = h.gate.snapshot().lastShownAt;

    h.advance(5_000);
    const again = h.gate.request('feed:afterChange', 'survey');
    const other = h.gate.request('offer:1', 'offer');
    await h.flush();
    expect(await again).toBe(true);
    expect(await other).toBe(false);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.gate.snapshot().lastShownAt).toBe(stamped);
  });

  it('a new page view ends the hold: the old key is judged like any other (24 h gap)', async () => {
    const h = harness();
    h.gate.notePageView('/jobs');
    const first = h.gate.request('feed:afterChange', 'survey');
    await h.flush();
    expect(await first).toBe(true);
    h.gate.notePageView('/resume');
    const next = h.gate.request('feed:afterChange', 'survey');
    await h.flush();
    expect(await next).toBe(false);
  });
});

describe('usePopupGate under React Strict Mode', () => {
  beforeEach(() => {
    nav.pathname = '/jobs';
    __setPopupGate(null);
    window.localStorage.clear();
  });
  afterEach(() => {
    __setPopupGate(null);
    window.localStorage.clear();
  });

  function Prompt({ id, enabled = true }: { id: string; enabled?: boolean }) {
    const { granted } = usePopupGate(id, 'announcement', { essential: true, enabled });
    return granted ? <p>{id} shown</p> : null;
  }

  it('shows the popup although the mount effect ran twice', async () => {
    notePageView('/jobs');
    render(
      <StrictMode>
        <Prompt id="onboarding:tour" />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText('onboarding:tour shown')).toBeInTheDocument());
    expect(getPopupGate().snapshot().shownThisView).toBe('onboarding:tour');
  });

  it('still shows only one of two different popups', async () => {
    notePageView('/jobs');
    render(
      <StrictMode>
        <Prompt id="first" />
        <Prompt id="second" />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText('first shown')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByText('second shown')).toBeNull();
  });

  it('an effect that re-runs after the slot was decided keeps its popup (the grant is not lost)', async () => {
    notePageView('/jobs');
    let setEnabled!: (v: boolean) => void;
    function Host() {
      const [enabled, set] = useState(true);
      setEnabled = set;
      return <Prompt id="onboarding:tour" enabled={enabled} />;
    }
    render(<Host />);
    // The request is pending; its effect is cleaned up before the gate decides, then it asks again.
    act(() => setEnabled(false));
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByText('onboarding:tour shown')).toBeNull();
    act(() => setEnabled(true));
    await waitFor(() => expect(screen.getByText('onboarding:tour shown')).toBeInTheDocument());
  });
});

// Review finding: the shell (app/(auth)/layout.tsx AuthLayoutSlots) notes the
// page view in ITS effect, and every prompt is its child. Child effects run
// first, so a prompt that mounted in the same commit as the route change asked
// under the old view and was denied with it. These tests keep the shell's real
// effect order (nothing notes the view before render).
describe('usePopupGate inside a shell that notes the page view in its own effect', () => {
  beforeEach(() => {
    nav.pathname = '/jobs';
    __setPopupGate(null);
    window.localStorage.clear();
  });
  afterEach(() => {
    __setPopupGate(null);
    window.localStorage.clear();
  });

  /** Same shape as AuthLayoutSlots: the parent effect, after the children's. */
  function Shell({ pathname, children }: { pathname: string; children: ReactNode }) {
    useEffect(() => {
      notePageView(pathname);
    }, [pathname]);
    return <>{children}</>;
  }
  function Prompt({ id, enabled = true }: { id: string; enabled?: boolean }) {
    const { granted } = usePopupGate(id, 'announcement', { essential: true, enabled });
    return granted ? <p>{id} shown</p> : null;
  }

  it.each([
    ['plain', false],
    ['Strict Mode', true],
  ])('shows a prompt that mounts in the same commit as the shell (%s)', async (_name, strict) => {
    const tree = (
      <Shell pathname="/jobs">
        <Prompt id="onboarding:tour" />
      </Shell>
    );
    render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    await waitFor(() => expect(screen.getByText('onboarding:tour shown')).toBeInTheDocument());
    expect(getPopupGate().snapshot()).toMatchObject({ viewKey: '/jobs', shownThisView: 'onboarding:tour' });
  });

  it('shows a prompt that mounts on the route change itself (the shell stays mounted)', async () => {
    function App({ pathname }: { pathname: string }) {
      return <Shell pathname={pathname}>{pathname === '/jobs' ? <Prompt id="onboarding:finishBanner" /> : null}</Shell>;
    }
    nav.pathname = '/resume';
    const view = render(<App pathname="/resume" />);
    await new Promise((r) => setTimeout(r, 80));
    nav.pathname = '/jobs';
    view.rerender(<App pathname="/jobs" />);
    await waitFor(() => expect(screen.getByText('onboarding:finishBanner shown')).toBeInTheDocument());
    expect(getPopupGate().snapshot()).toMatchObject({ viewKey: '/jobs', shownThisView: 'onboarding:finishBanner' });
  });

  it('still one popup per page view, and a new view frees the slot', async () => {
    function App({ pathname }: { pathname: string }) {
      return (
        <Shell pathname={pathname}>
          {pathname === '/jobs' ? (
            <>
              <Prompt id="first" />
              <Prompt id="second" />
            </>
          ) : (
            <Prompt id="third" />
          )}
        </Shell>
      );
    }
    const view = render(<App pathname="/jobs" />);
    await waitFor(() => expect(screen.getByText('first shown')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByText('second shown')).toBeNull();
    nav.pathname = '/resume';
    view.rerender(<App pathname="/resume" />);
    await waitFor(() => expect(screen.getByText('third shown')).toBeInTheDocument());
  });

  it('a route change alone does not make a mounted prompt ask again', async () => {
    // Refused on /jobs (the slot went to "first"); it stays refused after the route changes under it.
    function App({ pathname }: { pathname: string }) {
      return (
        <Shell pathname={pathname}>
          {pathname === '/jobs' ? <Prompt id="first" /> : null}
          <Prompt id="standing" />
        </Shell>
      );
    }
    const view = render(<App pathname="/jobs" />);
    await waitFor(() => expect(screen.getByText('first shown')).toBeInTheDocument());
    nav.pathname = '/resume';
    view.rerender(<App pathname="/resume" />);
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByText('standing shown')).toBeNull();
  });

  it('asks without noting a view when there is no router (pathname null)', async () => {
    nav.pathname = null;
    notePageView('/jobs');
    render(<Prompt id="outside" />);
    await waitFor(() => expect(screen.getByText('outside shown')).toBeInTheDocument());
    expect(getPopupGate().snapshot().viewKey).toBe('/jobs');
  });
});
