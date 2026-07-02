// ChipRow — suggestion chips send their text on tap; quick-replies carry
// MACHINE ids and hand back the full {id, label} option so the caller sends
// {message: label, quickReplyId: id} (design-review fix E10 — closed-set
// choices never get laundered through the LLM extractor).

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { ChipRow } from '../../components/v3/onboarding/ChipRow';

describe('ChipRow', () => {
  it('suggestion chip tap sends the chip text', () => {
    const onChip = vi.fn();
    renderWithProviders(
      <ChipRow
        chips={['Show me jobs now', 'NT$1.6M+ per year']}
        quickReplies={[]}
        onChip={onChip}
        onQuickReply={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show me jobs now' }));
    expect(onChip).toHaveBeenCalledWith('Show me jobs now');
  });

  it('quick-reply tap sends the machine id alongside the localized label (E10)', () => {
    const onQuickReply = vi.fn();
    renderWithProviders(
      <ChipRow
        chips={[]}
        quickReplies={[
          { id: 'no_preference', label: 'どちらでも' },
          { id: 'remote', label: 'リモート' },
        ]}
        onChip={() => {}}
        onQuickReply={onQuickReply}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'どちらでも' }));
    expect(onQuickReply).toHaveBeenCalledWith({
      id: 'no_preference',
      label: 'どちらでも',
    });
  });

  it('aggressiveness quick-replies surface their machine ids for the wrap short-circuit', () => {
    const onQuickReply = vi.fn();
    renderWithProviders(
      <ChipRow
        chips={[]}
        quickReplies={[
          { id: 'manual', label: 'I review everything' },
          { id: 'balanced', label: 'Balanced' },
          { id: 'aggressive', label: 'Full auto' },
        ]}
        onChip={() => {}}
        onQuickReply={onQuickReply}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Balanced' }));
    expect(onQuickReply).toHaveBeenCalledWith({
      id: 'balanced',
      label: 'Balanced',
    });
  });

  it('disabled blocks both tap kinds', () => {
    const onChip = vi.fn();
    const onQuickReply = vi.fn();
    renderWithProviders(
      <ChipRow
        chips={['A chip']}
        quickReplies={[{ id: 'x', label: 'Pill' }]}
        disabled
        onChip={onChip}
        onQuickReply={onQuickReply}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'A chip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pill' }));
    expect(onChip).not.toHaveBeenCalled();
    expect(onQuickReply).not.toHaveBeenCalled();
  });

  it('renders nothing when there are no chips and no quick-replies', () => {
    const { container } = renderWithProviders(
      <ChipRow chips={[]} quickReplies={[]} onChip={() => {}} onQuickReply={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
