// BuilderDesigner — 4 sub-tabs and the Presentation form. Verifies sub-tab
// switching, template selection emits onChange, font/date/skills layout pickers
// write through, and the accent-swatch click updates the theme.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { BuilderDesigner } from '../../components/resumes/builder/BuilderDesigner';
import { DEFAULT_THEME } from '../../lib/resumeTheme';

function setup(overrides = {}) {
  const onChange = vi.fn();
  const theme = { ...DEFAULT_THEME, ...overrides };
  render(<BuilderDesigner theme={theme} onChange={onChange} />);
  return { onChange, theme };
}

describe('BuilderDesigner', () => {
  it('renders the 4 sub-tabs and starts on Presentation', () => {
    setup();
    expect(screen.getByRole('tab', { name: /Presentation/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Sections/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Settings/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Advanced/i })).toBeInTheDocument();
  });

  it('switches to a stub sub-tab when clicked', () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: /Sections/i }));
    expect(
      screen.getByText(/Toggle which sections appear/i),
    ).toBeInTheDocument();
  });

  it('selecting a template button calls onChange with that templateKey', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByTitle(/Colored name accent/i));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].templateKey).toBe('modern');
  });

  it('picking an accent swatch writes the new color', () => {
    const { onChange } = setup();
    const swatch = screen.getByRole('button', { name: /^Teal$/ });
    fireEvent.click(swatch);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].accent).toBe('#0f766e');
  });

  it('changing the font dropdown writes the new font key', () => {
    const { onChange } = setup();
    const fontSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(fontSelect, { target: { value: 'poppins' } });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].font).toBe('poppins');
  });

  it('clicking a header-alignment tile writes headerAlignment', () => {
    const { onChange } = setup();
    // The TilePicker exposes its options as buttons; the visible text label
    // sits next to the mini-mockup.
    const headerSection = screen.getByText('Header Alignment').parentElement!;
    fireEvent.click(within(headerSection).getByText('Center'));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].headerAlignment).toBe('center');
  });

  it('clicking a skills-layout tile writes skillsLayout', () => {
    const { onChange } = setup();
    const section = screen.getByText('Skills Layout').parentElement!;
    fireEvent.click(within(section).getByText('Columns'));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].skillsLayout).toBe('columns');
  });
});
