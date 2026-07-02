// DataTable — borderless table with row dividers (--robo-line-soft), optional
// caption, two-column label/value layout.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable } from '../../components/chat/DataTable';

describe('DataTable', () => {
  it('renders rows with label + value', () => {
    render(
      <DataTable
        rows={[
          { label: 'Overall match', value: '88' },
          { label: 'Skill alignment', value: '90' },
        ]}
      />,
    );
    expect(screen.getByText(/Overall match/i)).toBeInTheDocument();
    expect(screen.getByText(/88/)).toBeInTheDocument();
    expect(screen.getByText(/Skill alignment/i)).toBeInTheDocument();
    expect(screen.getByText(/90/)).toBeInTheDocument();
  });

  it('borderless table with row dividers — uses border-t border-ink-line-soft on rows after the first', () => {
    const { container } = render(
      <DataTable
        rows={[
          { label: 'A', value: '1' },
          { label: 'B', value: '2' },
          { label: 'C', value: '3' },
        ]}
      />,
    );
    const trs = container.querySelectorAll('tr');
    expect(trs.length).toBe(3);
    // First row has no border-t.
    expect(trs[0].className).not.toMatch(/border-t/);
    // Second + third rows do.
    expect(trs[1].className).toMatch(/border-t/);
    expect(trs[1].className).toMatch(/border-ink-line-soft/);
    expect(trs[2].className).toMatch(/border-t/);
  });

  it('caption renders above the table when provided', () => {
    render(
      <DataTable
        caption="MATCH BREAKDOWN"
        rows={[{ label: 'Overall', value: '88' }]}
      />,
    );
    expect(screen.getByText(/MATCH BREAKDOWN/)).toBeInTheDocument();
  });

  it('row hint renders under the label as muted text', () => {
    const { container } = render(
      <DataTable
        rows={[
          {
            label: 'Engineering leadership',
            value: 'Yes',
            hint: 'Led 4-person team at Stripe',
          },
        ]}
      />,
    );
    expect(screen.getByText(/Engineering leadership/)).toBeInTheDocument();
    expect(screen.getByText(/Led 4-person team at Stripe/)).toBeInTheDocument();
    // Hint is rendered with text-ink-500 (muted).
    const hint = container.querySelector('.text-ink-500');
    expect(hint).not.toBeNull();
  });

  it('accessible: rows are tr elements within a table', () => {
    render(
      <DataTable rows={[{ label: 'Skill', value: 'High' }]} />,
    );
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    const row = screen.getByRole('row');
    expect(row).toBeInTheDocument();
  });
});
