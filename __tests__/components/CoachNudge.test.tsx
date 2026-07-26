// CoachNudge — the silent coach line beside the interviewer.
//
// Split out of the old Dc.test.tsx (which also covered AiOrb + TweaksPanel,
// both deleted with the accent/density era). Phase selection swaps with the
// draft word count; the card renders nothing while hidden.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CoachNudge } from '../../components/mock-interview/v3/CoachNudge';

describe('CoachNudge', () => {
  it('renders nothing when hidden', () => {
    const { container } = render(
      <CoachNudge question="Tell me about a hard project." draftWordCount={0} visible={false} />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('renders an opening-phase nudge when draft is short', () => {
    render(
      <CoachNudge question="Tell me about a hard project." draftWordCount={10} visible />,
    );
    expect(screen.getByText(/Your coach/i)).toBeInTheDocument();
  });
});
