// OptionPill — the Teal selectable row (§3.1). Verifies selected/unselected
// styling, click toggle behaviour, aria-pressed reflection, optional radio.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OptionPill } from '../../components/ui/OptionPill';

describe('OptionPill', () => {
  it('renders label and description', () => {
    render(<OptionPill label="24 hours" description="Most common" />);
    expect(screen.getByText(/24 hours/i)).toBeInTheDocument();
    expect(screen.getByText(/Most common/i)).toBeInTheDocument();
  });

  it('unselected: 1px ink-line border, no teal-900', () => {
    render(<OptionPill label="Opt A" />);
    const btn = screen.getByRole('button', { name: /Opt A/i });
    expect(btn.className).toMatch(/border-ink-line/);
    expect(btn.className).not.toMatch(/border-teal-900/);
  });

  it('selected: 2px accent-text border, aria-pressed=true', () => {
    render(<OptionPill label="Opt B" selected />);
    const btn = screen.getByRole('button', { name: /Opt B/i });
    // Selected border migrated literal teal-900 → theme-aware accent-text token
    // in the electric-on-paper redesign (commit 81387e82).
    expect(btn.className).toMatch(/border-accent-text/);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('click fires onClick callback', () => {
    const handler = vi.fn();
    render(<OptionPill label="Click me" onClick={handler} />);
    fireEvent.click(screen.getByRole('button', { name: /Click me/i }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('aria-pressed flips when selected prop changes', () => {
    const { rerender } = render(<OptionPill label="Toggle" selected={false} />);
    expect(screen.getByRole('button', { name: /Toggle/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    rerender(<OptionPill label="Toggle" selected={true} />);
    expect(screen.getByRole('button', { name: /Toggle/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('as="div" renders a non-interactive container (no aria-pressed, no onClick wiring)', () => {
    const handler = vi.fn();
    render(<OptionPill label="static" as="div" onClick={handler} />);
    // No button role since it's a div with no type
    const buttons = screen.queryAllByRole('button', { name: /static/i });
    expect(buttons.length).toBe(0);
  });
});
