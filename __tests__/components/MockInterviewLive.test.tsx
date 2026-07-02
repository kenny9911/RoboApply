// Mock Interview Live (v3) — InterviewerWell + VideoPanel + CoachCard +
// LiveTranscript + TopStatusBar.
//
// Smoke tests pin the most user-visible labels / aria attributes so future
// copy tweaks don't accidentally drop the wiring.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { InterviewerWell } from '../../components/mock-interview/v3/InterviewerWell';
import { VideoPanel } from '../../components/mock-interview/v3/VideoPanel';
import { CoachCard } from '../../components/mock-interview/v3/CoachCard';
import { LiveTranscript } from '../../components/mock-interview/v3/LiveTranscript';
import { TopStatusBar } from '../../components/mock-interview/v3/TopStatusBar';
import { PERSONAS } from '../../lib/mockInterview/personas';
import type { MockTurn } from '../../lib/mockInterview/types';

describe('InterviewerWell', () => {
  it('renders persona name + archetype + eyebrow + status', () => {
    render(
      <InterviewerWell
        persona={PERSONAS[1]} // Dr. Voss
        statusLabel="Listening"
        statusTint="red"
      />,
    );
    expect(screen.getByText('Dr. Voss')).toBeInTheDocument();
    expect(screen.getByText(/The Skeptical VP/i)).toBeInTheDocument();
    expect(screen.getByText(/AI Interviewer/i)).toBeInTheDocument();
    expect(screen.getByText(/Listening/i)).toBeInTheDocument();
  });
});

describe('VideoPanel', () => {
  it('shows MIC OFF + Camera off when mic and camera are disabled', () => {
    render(<VideoPanel name="Maya Chen" role="Senior PM" micOpen={false} cameraOn={false} />);
    expect(screen.getByText(/MIC OFF/i)).toBeInTheDocument();
    expect(screen.getByText(/Camera off/i)).toBeInTheDocument();
    expect(screen.getByText('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText(/Senior PM/i)).toBeInTheDocument();
  });
  it('shows MIC OPEN when mic is on', () => {
    render(<VideoPanel name="Maya" role="Senior PM" micOpen cameraOn={false} />);
    expect(screen.getByText(/MIC OPEN/i)).toBeInTheDocument();
  });
});

describe('CoachCard', () => {
  it('returns null when hidden', () => {
    const { container } = render(
      <CoachCard question="Walk me through a decision" draftWordCount={0} visible={false} />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
  it('shows YOUR COACH eyebrow and a phase line when visible', () => {
    render(<CoachCard question="Walk me through" draftWordCount={40} visible />);
    expect(screen.getByText(/Your Coach/i)).toBeInTheDocument();
  });
  it('fires onDismiss when the X is clicked', () => {
    const onDismiss = vi.fn();
    render(<CoachCard question="Walk me through" draftWordCount={40} visible onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss coach/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('LiveTranscript', () => {
  const turns: MockTurn[] = [
    { id: 't1', role: 'interviewer', at: '2026-05-28T00:00:00Z', questionId: 'q1', text: 'Tell me about a hard decision.' },
    { id: 't2', role: 'candidate', at: '2026-05-28T00:00:30Z', questionId: 'q1', text: 'At Mavn we shipped a clinician inbox redesign.' },
  ];

  it('renders the header + speaker labels + turn text', () => {
    render(<LiveTranscript turns={turns} interviewerName="Dr. Voss" />);
    expect(screen.getByText(/Live Transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/Auto-saved/i)).toBeInTheDocument();
    expect(screen.getByText('DR. VOSS')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText(/At Mavn we shipped/i)).toBeInTheDocument();
  });

  it('renders an empty placeholder when no turns yet', () => {
    render(<LiveTranscript turns={[]} interviewerName="Dr. Voss" />);
    expect(screen.getByText(/will start in a moment/i)).toBeInTheDocument();
  });
});

describe('TopStatusBar', () => {
  it('shows the track + format + clock + progress pips', () => {
    const { container } = render(
      <TopStatusBar
        trackTitle="Senior PM"
        formatLabel="Behavioral"
        elapsedSec={16}
        currentIndex={0}
        total={5}
      />,
    );
    expect(screen.getByText('Senior PM')).toBeInTheDocument();
    expect(screen.getByText('Behavioral')).toBeInTheDocument();
    expect(screen.getByText('Video')).toBeInTheDocument();
    expect(screen.getByText('00:16')).toBeInTheDocument();
    expect(screen.getByText(/Back to setup/i)).toBeInTheDocument();
    // 5 progress pips
    const pips = container.querySelector('[aria-label="Question 1 of 5"]');
    expect(pips?.children.length).toBe(5);
  });
});
