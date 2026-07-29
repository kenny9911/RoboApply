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
import { screen, fireEvent } from '@testing-library/react';

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
