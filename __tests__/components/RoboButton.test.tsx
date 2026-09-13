// RoboButton — variants, disabled state, click handler.
//
// Primary and outline variants use the shared action/surface tokens in both
// themes. Plus ghost, danger. Disabled state must visually
// disable AND drop button.disabled = true.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RoboButton } from '../../components/ui/RoboButton';

describe('RoboButton', () => {
  it('renders primary variant by default with theme-aware action colors', () => {
    render(<RoboButton>Submit</RoboButton>);
    const btn = screen.getByRole('button', { name: /Submit/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveClass('bg-action', 'text-action-ink');
  });

  it('renders outline variant with theme-aware surface and action border', () => {
    render(<RoboButton variant="outline">Next</RoboButton>);
    const btn = screen.getByRole('button', { name: /Next/i });
    expect(btn).toHaveClass('bg-surface', 'border-action', 'text-action');
  });

  it('renders ghost variant', () => {
    render(<RoboButton variant="ghost">Cancel</RoboButton>);
    const btn = screen.getByRole('button', { name: /Cancel/i });
    expect(btn.className).toMatch(/bg-transparent/);
  });

  it('disabled state: button.disabled is true and click handler does NOT fire', () => {
    const onClick = vi.fn();
    render(
      <RoboButton disabled onClick={onClick}>
        Cannot click
      </RoboButton>,
    );
    const btn = screen.getByRole('button', { name: /Cannot click/i }) as HTMLButtonElement;
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires click handler when enabled', () => {
    const onClick = vi.fn();
    render(<RoboButton onClick={onClick}>Submit</RoboButton>);
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('loading state disables and shows spinner', () => {
    const onClick = vi.fn();
    render(
      <RoboButton loading onClick={onClick}>
        Saving
      </RoboButton>,
    );
    const btn = screen.getByRole('button', { name: /Saving/i }) as HTMLButtonElement;
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('size lg renders h-14', () => {
    render(<RoboButton size="lg">Big</RoboButton>);
    const btn = screen.getByRole('button', { name: /Big/i });
    expect(btn.className).toMatch(/h-14/);
  });

  it('fullWidth applies w-full', () => {
    render(<RoboButton fullWidth>Stretchy</RoboButton>);
    expect(screen.getByRole('button', { name: /Stretchy/i }).className).toMatch(/w-full/);
  });
});
