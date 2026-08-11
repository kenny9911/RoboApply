import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { LiveBar } from '../LiveBar';

const baseProps = {
  role: 'Product Manager',
  typeLabel: 'Past situations',
  format: 'video' as const,
  elapsedSec: 125,
  currentIndex: 0,
  total: 0,
  onBack: vi.fn(),
};

describe('LiveBar', () => {
  it('omits question progress for a conversational session with no fixed total', () => {
    renderWithProviders(<LiveBar {...baseProps} />);

    expect(document.querySelector('.iv-live-progress')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Question \d+ of 0/)).not.toBeInTheDocument();
    expect(screen.getByText('02:05')).toBeInTheDocument();
  });

  it('clamps an out-of-range index before labelling optional progress', () => {
    renderWithProviders(<LiveBar {...baseProps} total={3} currentIndex={99} />);

    const progress = screen.getByLabelText('Question 3 of 3');
    expect(progress.querySelectorAll('.iv-pip')).toHaveLength(3);
    expect(progress.querySelectorAll('.iv-pip')[2]).toHaveClass('active');
  });

  it('keeps the compact back control accessible and sanitizes invalid timing data', () => {
    const onBack = vi.fn();
    renderWithProviders(
      <LiveBar {...baseProps} elapsedSec={Number.NaN} total={Number.NaN} onBack={onBack} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to setup' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(document.querySelector('.iv-live-progress')).not.toBeInTheDocument();
  });
});
