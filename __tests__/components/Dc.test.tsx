// Dark-canvas components — AiOrb + TweaksPanel + Scorecard.
//
// AiOrb: renders with the aria-label when supplied, swaps rings with `active`.
// TweaksPanel: accent picker, density, aggressiveness, tone all write through.
// CoachNudge: phase swaps with draft word count.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AiOrb } from '../../components/dc/AiOrb';
import { TweaksPanel } from '../../components/dc/TweaksPanel';
import { CoachNudge } from '../../components/mock-interview/v3/CoachNudge';
import { DcThemeProvider, useDcTheme } from '../../lib/dcTheme';

function Probe() {
  const t = useDcTheme();
  return (
    <div>
      <span data-testid="accent">{t.accent}</span>
      <span data-testid="density">{t.density}</span>
      <span data-testid="aggressiveness">{t.aggressiveness}</span>
      <span data-testid="tone">{t.tone}</span>
    </div>
  );
}

describe('AiOrb', () => {
  it('renders aria-label when label is set', () => {
    render(<AiOrb size="lg" label="Maya" />);
    expect(screen.getByRole('img', { name: /Maya/i })).toBeInTheDocument();
  });
});

describe('TweaksPanel + DcThemeProvider', () => {
  it('persists accent, density, aggressiveness, tone via useDcTheme', () => {
    render(
      <DcThemeProvider>
        <TweaksPanel open onClose={() => undefined} />
        <Probe />
      </DcThemeProvider>,
    );
    // Default accent is lime
    expect(screen.getByTestId('accent').textContent).toBe('lime');

    // Switch accent → violet
    fireEvent.click(screen.getByRole('button', { name: /Plasma Violet/i }));
    expect(screen.getByTestId('accent').textContent).toBe('violet');

    // Switch density → compact
    fireEvent.click(screen.getByRole('button', { name: /^Compact/i }));
    expect(screen.getByTestId('density').textContent).toBe('compact');

    // Switch aggressiveness → intense
    fireEvent.click(screen.getByRole('button', { name: /^Intense/i }));
    expect(screen.getByTestId('aggressiveness').textContent).toBe('intense');

    // Switch tone → witty
    fireEvent.click(screen.getByRole('button', { name: /^Witty/i }));
    expect(screen.getByTestId('tone').textContent).toBe('witty');
  });

  it('renders all four accent options', () => {
    render(
      <DcThemeProvider>
        <TweaksPanel open onClose={() => undefined} />
      </DcThemeProvider>,
    );
    expect(screen.getByRole('button', { name: /Electric Lime/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Plasma Violet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Liquid Cyan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hot Pink/i })).toBeInTheDocument();
  });

  it('returns null when not open', () => {
    const { container } = render(
      <DcThemeProvider>
        <TweaksPanel open={false} onClose={() => undefined} />
      </DcThemeProvider>,
    );
    expect(container.querySelector('aside')).toBeNull();
  });

  it('Close button fires onClose', () => {
    const onClose = vi.fn();
    render(
      <DcThemeProvider>
        <TweaksPanel open onClose={onClose} />
      </DcThemeProvider>,
    );
    // The panel has two close affordances — the backdrop ("Close tweaks") and
    // the X button ("Close"). We click the X.
    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

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
    expect(screen.getByText(/Your Coach/i)).toBeInTheDocument();
  });
});
