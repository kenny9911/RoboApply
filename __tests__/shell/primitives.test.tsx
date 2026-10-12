// FND-6a — shared primitives (components/v3/primitives; ARCHITECTURE.md §10.2)
// and the D3 helpers in components/features/common.
//
// Acceptance: FitMeter always renders "This is not your chance of getting
// hired."; SourceNote renders "Estimate" for ai_estimate and suppresses below
// MIN_SAMPLE. Plus the client/server parity of MIN_SAMPLE and the fit tiers,
// the honesty strings, CreditNotice, Tabs, Drawer/Sheet focus and Toast.

import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';

import { renderWithProviders } from '../utils/renderWithProviders';
import {
  CreditNotice,
  Drawer,
  FitMeter,
  FitTierLabel,
  HonestyLine,
  MIN_SAMPLE,
  Sheet,
  SourceNote,
  SourcedValue,
  Tabs,
  Toaster,
  tabPanelProps,
  toast,
} from '../../components/v3/primitives';
import { __toastStore, MAX_TOASTS } from '../../components/v3/primitives/Toast';
import { DEFAULT_MATCH_TIERS, tierForScore, isSuppressed, sourceLabelKey } from '../../components/features/common';
import * as serverHttp from '../../server/src/platform/http';
import * as serverMatch from '../../server/src/features/match/contract';

const LINE = 'This is not your chance of getting hired.';

describe('FitMeter / FitTierLabel', () => {
  it('always renders the honesty line — with a score, without one, compact', () => {
    const { unmount } = renderWithProviders(<FitMeter score={87} tier="great" />);
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.getByText('Great fit')).toBeInTheDocument();
    expect(screen.getByText('87 / 100 — how well your resume lines up with this job post')).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '87');
    unmount();

    const second = renderWithProviders(<FitMeter score={null} />);
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('No fit score for this job yet.')).toBeInTheDocument();
    expect(screen.getByRole('meter')).not.toHaveAttribute('aria-valuenow');
    second.unmount();

    renderWithProviders(<FitMeter score={50} compact />);
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(/\/ 100 —/)).not.toBeInTheDocument();
  });

  it('prints only the four tier words, from the server tier or the default thresholds', () => {
    const cases: [number, string][] = [
      [80, 'Great fit'],
      [79, 'Good fit'],
      [65, 'Good fit'],
      [64, 'Possible'],
      [45, 'Possible'],
      [44, 'Unlikely'],
    ];
    for (const [score, word] of cases) {
      const { unmount } = renderWithProviders(<FitTierLabel score={score} />);
      expect(screen.getByText(word)).toBeInTheDocument();
      unmount();
    }
    renderWithProviders(<FitTierLabel tier="unlikely" score={99} />);
    expect(screen.getByText('Unlikely')).toBeInTheDocument();
  });

  it('client tiers mirror the server (R-09)', () => {
    expect(DEFAULT_MATCH_TIERS).toEqual(serverMatch.DEFAULT_MATCH_TIERS);
    for (let s = 0; s <= 100; s += 1) expect(tierForScore(s)).toBe(serverMatch.tierForScore(s));
  });
});

describe('SourceNote / SourcedValue (D3)', () => {
  const asOf = '2026-10-03T00:00:00.000Z';

  it('MIN_SAMPLE is 20 and equals the server twin', () => {
    expect(MIN_SAMPLE).toBe(20);
    expect(MIN_SAMPLE).toBe(serverHttp.MIN_SAMPLE);
  });

  it('renders "Estimate" and the method sentence for ai_estimate', () => {
    renderWithProviders(<SourceNote sourced={{ value: 120000, source: 'posting', method: 'ai_estimate', asOf }} />);
    const note = document.querySelector('[data-source-note]')!;
    expect(note).toHaveAttribute('data-source-note', 'estimate');
    expect(within(note as HTMLElement).getByText('Estimate.')).toBeInTheDocument();
    expect(note.textContent).toContain('Worked out by AI from the job post, so it can be wrong.');
  });

  it('a stated value has no "Estimate"', () => {
    renderWithProviders(<SourceNote sourced={{ value: 120000, source: 'posting', method: 'stated', asOf }} />);
    expect(screen.queryByText('Estimate.')).not.toBeInTheDocument();
    expect(document.querySelector('[data-source-note]')!.textContent).toContain('Source: the job post');
  });

  it('suppresses an aggregate below MIN_SAMPLE, value and all', () => {
    const below = { value: 142000, source: 'index', sampleSize: MIN_SAMPLE - 1, asOf };
    renderWithProviders(
      <>
        <span data-testid="v">
          <SourcedValue value={below} format={(v) => `$${v}`} />
        </span>
        <SourceNote sourced={below} />
      </>,
    );
    expect(screen.getByTestId('v')).toHaveTextContent('—');
    expect(screen.queryByText(/142000/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-source-note]')).toHaveAttribute('data-source-note', 'suppressed');
    expect(screen.getByText('Not enough data yet. This shows once at least 20 posts have it.')).toBeInTheDocument();
  });

  it('shows the value and N at MIN_SAMPLE', () => {
    const ok = { value: 142000, source: 'index', sampleSize: MIN_SAMPLE, asOf };
    renderWithProviders(
      <>
        <span data-testid="v">
          <SourcedValue value={ok} format={(v) => `$${v}`} />
        </span>
        <SourceNote sourced={ok} />
      </>,
    );
    expect(screen.getByTestId('v')).toHaveTextContent('$142000');
    expect(document.querySelector('[data-source-note]')!.textContent).toContain('20 posts');
  });

  it('unknown renders "—", never 0; a missing note renders nothing', () => {
    const { container } = renderWithProviders(
      <>
        <span data-testid="v">
          <SourcedValue value={null} />
        </span>
        <SourceNote sourced={null} />
      </>,
    );
    expect(screen.getByTestId('v')).toHaveTextContent('—');
    expect(container.querySelector('[data-source-note]')).toBeNull();
  });

  it('names real sources through a parameter, never a bundle literal', () => {
    renderWithProviders(<SourceNote sourced={{ value: 1, source: 'bank:gohire', asOf }} />);
    expect(document.querySelector('[data-source-note]')!.textContent).toContain('recruiter posts on GoHire');
    expect(sourceLabelKey('provider:jsearch')).toBe('provider');
    expect(sourceLabelKey('something-new')).toBe('other');
    expect(isSuppressed({ sampleSize: undefined })).toBe(false);
    expect(isSuppressed({ sampleSize: Number.NaN })).toBe(true);
  });
});

describe('HonestyLine', () => {
  it('renders each required string word for word', () => {
    const expected: [Parameters<typeof HonestyLine>[0]['kind'], string][] = [
      ['fit', LINE],
      ['ai_written', 'Written with AI. Check every line before you use it.'],
      ['search_results', 'Search results, not verified.'],
      ['sponsorship', 'From what the job post says. Confirm visa sponsorship with the employer.'],
      ['you_submit', 'You submit each application yourself.'],
    ];
    for (const [kind, text] of expected) {
      const { unmount } = renderWithProviders(<HonestyLine kind={kind} />);
      expect(screen.getByText(text)).toHaveAttribute('data-honesty', kind);
      unmount();
    }
  });
});

describe('CreditNotice', () => {
  const resetsAt = '2026-10-11T00:00:00.000Z';
  it('prints the server numbers, never "unlimited"', () => {
    const { unmount } = renderWithProviders(
      <CreditNotice bucket={{ window: 'day', remaining: 2, grantRemaining: 0, resetsAt }} />,
    );
    expect(screen.getByText('Uses 1 of your 2 left today')).toBeInTheDocument();
    unmount();

    const w = renderWithProviders(<CreditNotice cost={2} bucket={{ window: 'week', remaining: 1, grantRemaining: 3, resetsAt }} />);
    expect(screen.getByText('Uses 2 of your 4 left this week')).toBeInTheDocument();
    w.unmount();

    const u = renderWithProviders(<CreditNotice bucket={null} />);
    expect(screen.getByText('Credits left: —')).toBeInTheDocument();
    u.unmount();
    expect(document.body.textContent?.toLowerCase()).not.toContain('unlimited');
  });

  it('at zero says when more arrive and offers Pro only when the server says it is upgradable', () => {
    let clicked = 0;
    const { unmount } = renderWithProviders(
      <CreditNotice bucket={{ window: 'day', remaining: 0, grantRemaining: 0, resetsAt }} upgradable onUpgrade={() => (clicked += 1)} />,
    );
    expect(screen.getByText(/^None left today\. More on /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See Pro' }));
    expect(clicked).toBe(1);
    unmount();

    renderWithProviders(<CreditNotice bucket={{ window: 'day', remaining: 0, resetsAt }} onUpgrade={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'See Pro' })).not.toBeInTheDocument();
  });
});

describe('Tabs', () => {
  function Demo() {
    const [tab, setTab] = useState<'a' | 'b' | 'c'>('a');
    return (
      <>
        <Tabs
          ariaLabel="Job"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'a', label: 'Overview' },
            { id: 'b', label: 'Company', count: 3 },
            { id: 'c', label: 'People', count: null },
          ]}
        />
        <div {...tabPanelProps('Job', tab)}>panel {tab}</div>
      </>
    );
  }

  it('selects by click and arrow keys, wraps, and links tab and panel', () => {
    renderWithProviders(<Demo />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(within(tabs[1]).getByText('3')).toBeInTheDocument();
    expect(tabs[2].textContent).toBe('People'); // null count draws nothing

    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'People' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'People' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /Company/ }));
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('panel b');
    expect(panel).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: /Company/ }).id);
  });
});

describe('Drawer / Sheet', () => {
  function Host({ kind }: { kind: 'drawer' | 'sheet' }) {
    const [open, setOpen] = useState(false);
    const Comp = kind === 'drawer' ? Drawer : Sheet;
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open it
        </button>
        <Comp open={open} onClose={() => setOpen(false)} title="Filters">
          <button type="button">First</button>
          <button type="button">Last</button>
        </Comp>
      </>
    );
  }

  for (const kind of ['drawer', 'sheet'] as const) {
    it(`${kind}: focus moves in, Tab stays inside, Escape closes and focus returns`, () => {
      renderWithProviders(<Host kind={kind} />);
      const trigger = screen.getByRole('button', { name: 'Open it' });
      trigger.focus();
      fireEvent.click(trigger);

      const dialog = screen.getByRole('dialog', { name: 'Filters' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('data-testid', kind);
      const close = within(dialog).getByRole('button', { name: 'Close' });
      expect(document.activeElement).toBe(close);

      const last = within(dialog).getByRole('button', { name: 'Last' });
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);

      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });
  }
});

describe('Toast', () => {
  afterEach(() => __toastStore.reset());

  it('shows a polite status with an optional action, at most three at once', () => {
    let undone = false;
    renderWithProviders(<Toaster />);
    act(() => {
      toast({ message: 'Moved to Applied', action: { label: 'Undo', onClick: () => (undone = true) } });
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Moved to Applied');
    fireEvent.click(within(status).getByRole('button', { name: 'Undo' }));
    expect(undone).toBe(true);
    expect(screen.queryByText('Moved to Applied')).not.toBeInTheDocument();

    act(() => {
      for (let i = 0; i < 5; i += 1) toast({ message: `t${i}` });
    });
    expect(screen.getAllByRole('status')).toHaveLength(MAX_TOASTS);
    expect(screen.queryByText('t0')).not.toBeInTheDocument();

    act(() => {
      toast({ message: 'It failed', tone: 'danger' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('It failed');
  });
});
