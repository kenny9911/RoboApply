// RoboInput — 56px height container, focus border, value binding, label
// wiring (htmlFor matches input id).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RoboInput } from '../../components/ui/RoboInput';

describe('RoboInput', () => {
  it('renders label associated with input via htmlFor/id', () => {
    render(<RoboInput label="Email" id="email" />);
    const input = screen.getByLabelText(/Email/i);
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
    expect(input.id).toBe('email');
  });

  it('outer container has h-14 (56px height) per Teal-UI §3.5', () => {
    const { container } = render(<RoboInput label="Title" />);
    const wrapper = container.querySelector('.h-14');
    expect(wrapper).not.toBeNull();
  });

  it('value binding: typing fires onChange with the new value', () => {
    const onChange = vi.fn();
    render(<RoboInput label="Name" onChange={onChange} />);
    const input = screen.getByLabelText(/Name/i);
    fireEvent.change(input, { target: { value: 'Alice' } });
    expect(onChange).toHaveBeenCalled();
    const evt = onChange.mock.calls[0][0];
    expect(evt.target.value).toBe('Alice');
  });

  it('hint text shows below the input when supplied (no error)', () => {
    render(<RoboInput label="Title" hint="e.g. Senior Software Engineer" />);
    expect(
      screen.getByText(/Senior Software Engineer/i),
    ).toBeInTheDocument();
  });

  it('error text shows with role=alert and uses danger color, replaces hint', () => {
    render(
      <RoboInput
        label="Email"
        hint="we keep it private"
        error="Email is invalid"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Email is invalid/i);
    expect(alert.className).toMatch(/text-danger/);
    // Hint must NOT render when error is present.
    expect(screen.queryByText(/we keep it private/i)).not.toBeInTheDocument();
  });
});
