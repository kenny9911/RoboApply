// RoboTextarea — value binding, error rendering, character count area
// (no built-in counter, but value/onChange contract must work).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RoboTextarea } from '../../components/ui/RoboTextarea';

describe('RoboTextarea', () => {
  it('renders label associated with textarea', () => {
    render(<RoboTextarea label="Intent" id="intent" />);
    const ta = screen.getByLabelText(/Intent/i);
    expect(ta).toBeInTheDocument();
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.id).toBe('intent');
  });

  it('value binding: typing fires onChange and updates value', () => {
    const onChange = vi.fn();
    render(<RoboTextarea label="Intent" onChange={onChange} />);
    const ta = screen.getByLabelText(/Intent/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'Senior PM at fintech' } });
    expect(onChange).toHaveBeenCalled();
    const evt = onChange.mock.calls[0][0];
    expect(evt.target.value).toBe('Senior PM at fintech');
  });

  it('controlled value renders', () => {
    render(<RoboTextarea label="Intent" value="canned text" onChange={() => {}} />);
    const ta = screen.getByLabelText(/Intent/i) as HTMLTextAreaElement;
    expect(ta.value).toBe('canned text');
  });

  it('default rows=4', () => {
    render(<RoboTextarea label="Intent" />);
    const ta = screen.getByLabelText(/Intent/i) as HTMLTextAreaElement;
    expect(ta.rows).toBe(4);
  });

  it('error renders as role=alert in text-danger', () => {
    render(
      <RoboTextarea label="Intent" error="Tell me what you're looking for first." />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/looking for first/i);
    expect(alert.className).toMatch(/text-danger/);
  });
});
