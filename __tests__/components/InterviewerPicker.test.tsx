// InterviewerPicker — renders the expanded archetype roster with localized
// persona text + archetype chips, fully i18n (the "Pick your interviewer" ask).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { InterviewerPicker } from '../../components/v3/mock/InterviewerPicker';
import { FIXTURE_MOCK_CATALOG } from '../../lib/fixtures/mockCatalog';
import { IntlWrapper } from '../utils/mockTranslations';

const interviewers = FIXTURE_MOCK_CATALOG.interviewers;

function renderPicker(onError?: (e: unknown) => void) {
  const utils = render(
    <IntlWrapper onError={onError}>
      <InterviewerPicker interviewers={interviewers} selectedId={null} onSelect={() => {}} />
    </IntlWrapper>,
  );
  // The roster collapses to the top COLLAPSE_LIMIT (6) by default (commit
  // 5cc1d14d). Expand via the "Show all" toggle so the full 18-persona roster
  // and every archetype chip is in the DOM for the assertions below.
  const showAll = screen.queryByRole('button', { name: /show all/i });
  if (showAll) fireEvent.click(showAll);
  return utils;
}

describe('InterviewerPicker (archetype roster)', () => {
  it('renders the localized heading and all 18 personas', () => {
    renderPicker();
    expect(screen.getByText('Pick your interviewer')).toBeInTheDocument();
    for (const p of interviewers) {
      expect(screen.getByText(p.name)).toBeInTheDocument();
    }
    expect(interviewers).toHaveLength(18);
  });

  it('renders localized persona role/blurb text (not raw i18n keys)', () => {
    const { container } = renderPicker();
    // en.json translations resolve to the English source text.
    expect(screen.getByText('The Warm Recruiter')).toBeInTheDocument();
    expect(screen.getByText('The Renaissance Architect')).toBeInTheDocument();
    // No raw key path leaked anywhere.
    expect(container.textContent).not.toMatch(/setup\.personas\./);
    expect(container.textContent).not.toMatch(/setup\.archetype\./);
  });

  it('shows an archetype chip on every card covering all 7 archetypes', () => {
    renderPicker();
    // English chip labels from mock.setup.archetype.*
    expect(screen.getAllByText('Deep-dive')).toHaveLength(3); // diaz, kai, voss
    expect(screen.getAllByText('Breadth')).toHaveLength(3); // nova, atlas, amara
    expect(screen.getAllByText('Behavioral')).toHaveLength(3); // priya, bishop, osei
    expect(screen.getAllByText('Problem-solving')).toHaveLength(3); // rex, okonkwo, devi
    expect(screen.getAllByText('Warm-up')).toHaveLength(2); // maya, june
    expect(screen.getAllByText('Communication')).toHaveLength(2); // lena, sterling
    expect(screen.getAllByText('Pressure')).toHaveLength(2); // mirae, tariq
  });

  it('every persona id present in the picker has a backend-aligned shape (palette pair + archetype)', () => {
    for (const p of interviewers) {
      expect(p.palette).toHaveLength(2);
      expect(['warmup', 'behavioral', 'breadth', 'potential', 'depth', 'communication', 'pressure']).toContain(p.archetype);
    }
  });

  it('logs no missing-i18n-key errors for any persona or archetype key', () => {
    const onError = vi.fn();
    renderPicker(onError);
    const missing = onError.mock.calls
      .map((c) => String((c[0] as { code?: string; message?: string })?.message ?? c[0]))
      .filter((m) => /MISSING_MESSAGE/i.test(m));
    expect(missing).toEqual([]);
  });
});
