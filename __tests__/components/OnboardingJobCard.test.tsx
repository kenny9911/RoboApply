// OnboardingJobCard — "via {publisher}" attribution renders for external
// (jsearch) cards only; external apply links carry target="_blank" +
// rel="noopener nofollow"; whyMatched renders through the sanitized Markdown
// primitive (XSS guard); Save/Pass fire the callbacks.

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '../utils/renderWithProviders';
import { OnboardingJobCard } from '../../components/v3/onboarding/OnboardingJobCard';
import type { OnboardingJobCard as CardData } from '../../lib/api/v2/types';

function makeJob(overrides: Partial<CardData> = {}): CardData {
  return {
    id: 'job1',
    title: 'Senior Backend Engineer',
    companyName: 'Acme Fintech',
    companyLogoUrl: null,
    location: 'Taipei, TW',
    workType: 'remote',
    salaryMin: 1600000,
    salaryMax: null,
    salaryCurrency: 'TWD',
    postedAt: '2026-06-01T00:00:00.000Z',
    isBookmarked: false,
    matchScoreCached: 84,
    matchScore: 84,
    whyMatched: 'Your **payments** background maps directly to this team.',
    source: 'internal',
    isExternal: false,
    ...overrides,
  };
}

const noop = () => {};

describe('OnboardingJobCard', () => {
  it('renders title, company, and match score', () => {
    renderWithProviders(
      <OnboardingJobCard
        job={makeJob()}
        saved={false}
        passed={false}
        onSave={noop}
        onPass={noop}
      />,
    );
    expect(screen.getByText('Senior Backend Engineer')).toBeInTheDocument();
    expect(screen.getByText(/Acme Fintech/)).toBeInTheDocument();
    expect(screen.getByText(/84% match/)).toBeInTheDocument();
  });

  it('shows "via {publisher}" for external cards only', () => {
    const { unmount } = renderWithProviders(
      <OnboardingJobCard
        job={makeJob({
          isExternal: true,
          source: 'jsearch',
          sourcePublisher: '104人力銀行',
          applyUrl: 'https://www.104.com.tw/job/abc',
        })}
        saved={false}
        passed={false}
        onSave={noop}
        onPass={noop}
      />,
    );
    expect(screen.getByText(/via 104人力銀行/)).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <OnboardingJobCard
        job={makeJob()}
        saved={false}
        passed={false}
        onSave={noop}
        onPass={noop}
      />,
    );
    expect(screen.queryByText(/via/)).not.toBeInTheDocument();
  });

  it('external apply link opens _blank with rel="noopener nofollow"', () => {
    renderWithProviders(
      <OnboardingJobCard
        job={makeJob({
          isExternal: true,
          source: 'jsearch',
          sourcePublisher: 'LinkedIn',
          applyUrl: 'https://example.com/apply/1',
        })}
        saved={false}
        passed={false}
        onSave={noop}
        onPass={noop}
      />,
    );
    const link = screen.getByRole('link', { name: /Open posting/i });
    expect(link).toHaveAttribute('href', 'https://example.com/apply/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener nofollow');
  });

  it('renders no apply link for internal cards', () => {
    renderWithProviders(
      <OnboardingJobCard
        job={makeJob()}
        saved={false}
        passed={false}
        onSave={noop}
        onPass={noop}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('whyMatched renders sanitized markdown — script tags are neutralized (XSS guard)', () => {
    renderWithProviders(
      <OnboardingJobCard
        job={makeJob({
          whyMatched:
            'Your **Go** experience fits. <script>window.__pwn = true</script><img src=x onerror="window.__pwn = true" />',
        })}
        saved={false}
        passed={false}
        onSave={noop}
        onPass={noop}
      />,
    );
    // Raw HTML is stripped by rehype-sanitize; markdown still renders.
    expect(document.querySelector('script')).toBeNull();
    expect((window as { __pwn?: boolean }).__pwn).toBeUndefined();
    const bold = screen.getByText('Go');
    expect(bold.tagName).toBe('STRONG');
  });

  it('Save / Pass fire the callbacks with the job', () => {
    const onSave = vi.fn();
    const onPass = vi.fn();
    const job = makeJob();
    renderWithProviders(
      <OnboardingJobCard
        job={job}
        saved={false}
        passed={false}
        onSave={onSave}
        onPass={onPass}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(onSave).toHaveBeenCalledWith(job);
    fireEvent.click(screen.getByRole('button', { name: /^Pass$/i }));
    expect(onPass).toHaveBeenCalledWith(job);
  });
});
