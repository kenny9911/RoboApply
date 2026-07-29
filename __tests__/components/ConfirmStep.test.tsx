// ConfirmStep — step 2. Confirmation, not interrogation.
//
// What these cases hold onto:
//   • every control arrives PREFILLED, so the screen can be accepted with one
//     tap and no typing;
//   • a removed chip is really removed;
//   • the resume's city is a QUESTION, never a prefilled value — it is the one
//     inferable-looking field that is most often wrong about intent, and
//     getting it wrong empties the feed silently;
//   • an inferred value never renders as a read value;
//   • there is no pay question, no level picker and no "Direction" control.

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { ConfirmStep } from '../../components/v3/setup/ConfirmStep';
import { weakSignalRoleSuggestions } from '../../components/v3/setup/ConfirmStep';
import { draftStateFromSession } from '../../hooks/useSetup';
import type { OnboardingSetupState } from '../../lib/api/v2/types';

const SESSION: OnboardingSetupState = {
  sessionId: 'obs_1',
  returning: false,
  resumeVariant: { id: 'rv_1', name: 'Master Resume' },
  ingestRows: [
    { id: 'r1', kind: 'identity', label: 'Name', value: 'Ada Lovelace' },
    { id: 'r2', kind: 'skills', label: 'Skills', value: 'Roadmapping · Pricing' },
  ],
  draft: {
    targetRoles: ['Senior Product Manager', 'QA Lead'],
    seniority: 'senior',
    employmentTypes: ['full_time'],
    industriesTarget: ['Healthtech'],
    locations: { cities: ['San Francisco'] },
  },
  fieldMeta: {
    targetRoles: { source: 'resume', confidence: 0.8 },
    employmentTypes: { source: 'resume', confidence: 0.6 },
    locations: { source: 'inferred', confidence: 0.5 },
  },
  proposedFields: ['locations'],
  evidence: {
    roles: ['Senior Product Manager', 'Group Product Manager'],
    years: 8,
    city: 'San Francisco',
  },
  thin: false,
  enrichmentPending: false,
};

function renderStep(session: OnboardingSetupState = SESSION) {
  const dispatch = vi.fn();
  const onSubmit = vi.fn();
  const onSkip = vi.fn();
  renderWithProviders(
    <ConfirmStep
      session={session}
      draft={draftStateFromSession(session)}
      dispatch={dispatch}
      freeText=""
      onFreeTextChange={() => {}}
      onSubmit={onSubmit}
      onSkip={onSkip}
      submitting={false}
      skipping={false}
    />,
  );
  return { dispatch, onSubmit, onSkip };
}

describe('ConfirmStep', () => {
  it('renders the seeded job titles as applied chips', () => {
    renderStep();
    expect(screen.getByText('Senior Product Manager')).toBeInTheDocument();
    expect(screen.getByText('QA Lead')).toBeInTheDocument();
  });

  it('shows the evidence that earned the prefill', () => {
    renderStep();
    expect(
      screen.getByText(/Your last jobs were Senior Product Manager/),
    ).toBeInTheDocument();
  });

  it('removing a chip dispatches a real removal', () => {
    const { dispatch } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /remove QA Lead/i }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'remove',
      field: 'targetRoles',
      value: 'QA Lead',
    });
  });

  it('offers the resume city as an UNSELECTED question, not a value', () => {
    renderStep();
    // The question is on screen…
    const suggestion = screen.getByRole('button', { name: /Still in San Francisco\?/i });
    expect(suggestion).toBeInTheDocument();
    // …and there is no chip you could remove, because nothing was applied.
    expect(
      screen.queryByRole('button', { name: /remove San Francisco/i }),
    ).not.toBeInTheDocument();
  });

  it('accepting the city takes one tap', () => {
    const { dispatch } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Still in San Francisco\?/i }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'add',
      field: 'locations',
      value: 'San Francisco',
    });
  });

  it('starts every work mode OFF and says why that is fine', () => {
    renderStep();
    for (const name of [/^Remote$/, /^Hybrid$/, /^In an office$/]) {
      expect(screen.getByRole('switch', { name })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    }
    expect(screen.getByText(/Every option stays in/i)).toBeInTheDocument();
  });

  it('marks a resume-read group differently from an inferred one', () => {
    renderStep();
    // Job titles came off the resume; the label says so.
    expect(screen.getAllByText(/From your resume/i).length).toBeGreaterThan(0);
    // Nothing is asserted as inferred yet, because the inferred field (the
    // city) has no applied value — an inferred marker on an empty group would
    // be a warning about a value that is not there.
    expect(screen.queryByText(/Check this one/i)).not.toBeInTheDocument();
  });

  it('has no pay question, no level picker and no Direction control', () => {
    renderStep();
    expect(screen.queryByText(/^Pay$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Level$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A step up/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/About the same level/i)).not.toBeInTheDocument();
  });

  it('shows no job cards — the destination is not rendered twice', () => {
    renderStep();
    expect(screen.queryByText(/\/ 100/)).not.toBeInTheDocument();
  });

  it('submits with nothing touched, and the button is never disabled', () => {
    const { onSubmit } = renderStep();
    const button = screen.getByRole('button', { name: /show me the jobs/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalled();
  });

  it('can be skipped, and says what skipping means', () => {
    const { onSkip } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalled();
    expect(screen.getByText(/every open job, newest first/i)).toBeInTheDocument();
  });

  it('degrades to the thin-resume screen rather than an empty one', () => {
    renderStep({
      ...SESSION,
      thin: true,
      draft: { ...SESSION.draft, targetRoles: [] },
      evidence: { years: 1 },
    });
    expect(screen.getByText(/did not say much/i)).toBeInTheDocument();
    // Weak signal from the resume itself, offered as taps rather than as an
    // open text field the thinnest resume is least able to fill.
    expect(screen.getByRole('button', { name: 'Roadmapping' })).toBeInTheDocument();
  });
});

// The chip groups carry the whole screen, so their keyboard and screen-reader
// behaviour is the screen's keyboard and screen-reader behaviour.
describe('ConfirmStep — chip group access', () => {
  /** The <section> GroupShell wraps one control in. */
  function groupOf(el: HTMLElement): HTMLElement {
    const section = el.closest('section');
    if (!section) throw new Error('chip is not inside a group');
    return section as HTMLElement;
  }

  it('keeps focus in the group after a chip is removed', () => {
    renderStep();
    const remove = screen.getByRole('button', { name: /remove QA Lead/i });
    const group = groupOf(remove);
    fireEvent.click(remove);
    // Removing is the core interaction of a confirm screen. Left alone the
    // button that had focus is destroyed and focus falls to <body> — after
    // every single removal.
    expect(document.activeElement).not.toBe(document.body);
    expect(group).toContainElement(document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).tagName).toBe('INPUT');
  });

  it('does not add a chip on the Enter that commits an IME candidate', () => {
    const { dispatch } = renderStep();
    const group = groupOf(screen.getByRole('button', { name: /remove QA Lead/i }));
    const input = within(group).getByPlaceholderText(/type, then press enter/i);

    fireEvent.change(input, { target: { value: 'データアナリスト' } });
    // zh, zh-TW, ja and ko all type through an IME. Without the guard the first
    // Enter of every entry adds a half-composed chip.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(dispatch).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'add',
      field: 'targetRoles',
      value: 'データアナリスト',
    });
  });

  it('names each control and the evidence that seeded it', () => {
    renderStep();
    const group = screen.getByRole('region', { name: 'Job titles you want' });
    // A screen-reader user arriving by Tab never passes the heading, so the
    // provenance marker and the why-line have to be the group's description
    // rather than text that merely sits nearby.
    expect(group).toHaveAccessibleDescription(/Your last jobs were/);
    expect(group).toHaveAccessibleDescription(/From your resume/);
  });

  it('separates suggestions from applied values for a screen reader', () => {
    renderStep();
    // Otherwise "San Francisco, button" is indistinguishable from a chip that
    // is already in the search.
    const suggestions = screen.getAllByRole('group', { name: /or pick one/i });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(
      within(suggestions[0]).getAllByRole('button').length,
    ).toBeGreaterThan(0);
  });

  it('exposes the applied chips as a countable set', () => {
    renderStep();
    const lists = screen.getAllByRole('list');
    const titles = lists.find((l) => within(l).queryByText('QA Lead'));
    expect(titles).toBeDefined();
    expect(within(titles as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('weakSignalRoleSuggestions', () => {
  it('reads the skills and education rows and nothing else', () => {
    expect(
      weakSignalRoleSuggestions([
        { id: '1', kind: 'identity', label: 'Name', value: 'Ada Lovelace' },
        { id: '2', kind: 'skills', label: 'Skills', value: 'SQL · Forecasting' },
        { id: '3', kind: 'education', label: 'Study', value: 'Statistics' },
      ]),
    ).toEqual(['SQL', 'Forecasting', 'Statistics']);
  });

  it('caps at eight and drops duplicates and stray punctuation', () => {
    const rows = [
      {
        id: '1',
        kind: 'skills' as const,
        label: 'Skills',
        value: 'a · SQL · sql · Bb · Cc · Dd · Ee · Ff · Gg · Hh · Ii',
      },
    ];
    const out = weakSignalRoleSuggestions(rows);
    expect(out).toHaveLength(8);
    expect(out).not.toContain('a');
    expect(out.filter((v) => v.toLowerCase() === 'sql')).toHaveLength(1);
  });

  it('returns nothing when there are no rows yet', () => {
    expect(weakSignalRoleSuggestions(null)).toEqual([]);
  });
});
