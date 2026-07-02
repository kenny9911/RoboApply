// BulletGuidancePanel — Bullet Score callout + 4 tabs (Suggestions /
// Assistant / Examples / Prompts). Verifies tab switching, example-click
// emits onInsert, and the Assistant phrase-builder composes a sensible
// starter phrase from its dropdowns.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, render } from '@testing-library/react';

import { BulletGuidancePanel } from '../../components/resumes/builder/BulletGuidancePanel';

describe('BulletGuidancePanel', () => {
  it('opens with the Suggestions tab and shows the success-formula text', () => {
    render(<BulletGuidancePanel onInsert={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /Suggestions/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByText(/success verb \+ noun \+ metric \+ outcome/i),
    ).toBeInTheDocument();
  });

  it('renders the Bullet Score callout with credit count', () => {
    render(
      <BulletGuidancePanel
        onInsert={vi.fn()}
        bulletScoreCreditsRemaining={1}
        bulletScoreCreditsTotal={2}
      />,
    );
    expect(screen.getByText(/Run Free Analysis \(1\/2\)/i)).toBeInTheDocument();
  });

  it('Examples tab fires onInsert with the example text when clicked', () => {
    const onInsert = vi.fn();
    render(<BulletGuidancePanel onInsert={onInsert} />);
    fireEvent.click(screen.getByRole('tab', { name: /Examples/i }));
    const firstExample = screen.getByText(/Increased website visitors by 132%/);
    fireEvent.click(firstExample);
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0]).toMatch(/Increased website visitors/);
  });

  it('Prompts tab fires onInsert with the prompt text when clicked', () => {
    const onInsert = vi.fn();
    render(<BulletGuidancePanel onInsert={onInsert} />);
    fireEvent.click(screen.getByRole('tab', { name: /Prompts/i }));
    fireEvent.click(screen.getByText(/Did you make the company money\?/));
    expect(onInsert).toHaveBeenCalledWith('Did you make the company money?');
  });

  it('Assistant tab builds a result from dropdowns and inserts it', () => {
    const onInsert = vi.fn();
    render(<BulletGuidancePanel onInsert={onInsert} />);
    fireEvent.click(screen.getByRole('tab', { name: /Assistant/i }));

    const selects = screen.getAllByRole('combobox');
    // Order: verb, noun, amount, timeSpan, connector
    fireEvent.change(selects[0], { target: { value: 'Increased' } });
    fireEvent.change(selects[1], { target: { value: 'revenue' } });
    fireEvent.change(selects[2], { target: { value: '25%' } });
    fireEvent.change(selects[3], { target: { value: 'in 6 months' } });
    fireEvent.change(selects[4], { target: { value: 'by' } });

    const strategy = screen.getByPlaceholderText('Type something…');
    fireEvent.change(strategy, { target: { value: 'launching a new pricing tier' } });

    expect(
      screen.getByText(/Increased revenue by 25% in 6 months by launching a new pricing tier/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Insert into composer/i }));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0]).toMatch(/Increased revenue by 25%/);
  });
});
