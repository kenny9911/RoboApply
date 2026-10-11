// WP-18 — fit components: the score always carries its honesty line, quick
// estimates are labelled, AI text carries AiGeneratedBadge (GoApply) and the
// AI-written line, the parts list shows weights/evidence/"not enough", the
// keyword rows never count "not stated" as a miss, and the fit analysis runs
// through the credit gate with an idempotency key.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getFitAnalysis: vi.fn(),
  getKeywordCheck: vi.fn(),
  scoreJob: vi.fn(),
  getCredits: vi.fn(),
}));

vi.mock('../market', () => ({
  AiGeneratedBadge: ({ kind }: { kind?: string }) => <span data-testid="ai-badge">AI-{kind}</span>,
}));
vi.mock('../../../lib/api/match', () => ({ getFitAnalysis: api.getFitAnalysis, getKeywordCheck: api.getKeywordCheck }));
vi.mock('../../../lib/api/jobs', () => ({ scoreJob: api.scoreJob }));
vi.mock('../../../lib/api/credits', () => ({ getCredits: api.getCredits }));

import { RoboApiError } from '../../../lib/api/client';
import type { FitAnalysisCard as Card, KeywordRow, MatchDimension, MatchFitView } from '../../../lib/api/contracts/match';
import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { DimensionList, FitAnalysisCard, FitAnalysisView, FitScore, JobFit, JobFitView, KeywordCheck, WhatYoureMissing, WhyYouFit } from './index';
import { uniq } from './JobFit';
import { plainQuote } from './labels';

const LINE = 'This is not your chance of getting hired.';
const AI_LINE = 'Written with AI. Check every line before you use it.';

const DIMS: MatchDimension[] = [
  { key: 'career_path', weight: 10, score: null, status: 'not_stated', evidence: [] },
  {
    key: 'title_level',
    weight: 35,
    score: 50,
    status: 'scored',
    evidence: [
      { text: 'Backend Engineer', source: 'posting', ref: 'title' },
      { text: 'senior', source: 'posting', ref: 'seniority' },
      { text: 'master', source: 'posting', ref: 'education_required' },
    ],
  },
  { key: 'skills', weight: 30, score: 67, status: 'scored', evidence: [{ text: 'TypeScript', source: 'resume', ref: 'skill_have' }, { text: 'Kubernetes', source: 'posting', ref: 'skill_missing' }] },
  { key: 'industry', weight: 15, score: 80, status: 'scored', evidence: [{ text: 'Built payment APIs', source: 'resume' }] },
  { key: 'logistics', weight: 10, score: 50, status: 'scored', evidence: [{ text: 'EUR 70000–90000', source: 'posting', ref: 'pay_not_met' }] },
];

function fit(overrides: Partial<MatchFitView> = {}): MatchFitView {
  return {
    jobId: 'job1',
    score: 74,
    tier: 'good',
    kind: 'ai',
    dimensions: DIMS,
    summary: 'Your payments work lines up well, though the post centres on Kubernetes.',
    strengths: ['Your payment APIs in Go'],
    gaps: ['No Kubernetes work shown'],
    keywordsMatched: [],
    keywordsMissing: ['Helm'],
    skills: { aligned: ['TypeScript', 'Go'], missing: ['Kubernetes'], listed: 3 },
    topOverlap: null,
    topGap: null,
    scoredAt: '2026-10-10T08:00:00.000Z',
    resumeVariantId: 'v1',
    estimateReason: null,
    summaryLocaleStale: false,
    cached: false,
    ...overrides,
  };
}

const CARD: Card = {
  jobId: 'job1',
  score: 74,
  tier: 'good',
  kind: 'ai',
  dimensions: DIMS,
  skills: { aligned: ['TypeScript'], missing: ['Kubernetes'], listed: 2 },
  education: { required: 'master', yours: 'BSc Computer Science', meets: false },
  highlights: ['Your payment APIs in Go'],
  gaps: ['No Kubernetes work shown'],
  summary: 'Your payments work lines up well.',
  aiWritten: true,
  estimateReason: null,
  charged: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCredits.mockResolvedValue({
    summary: { buckets: { fit_analysis: { window: 'day', cap: 10, used: 1, reserved: 0, remaining: 9, grantRemaining: 0, resetsAt: '2026-10-11T00:00:00Z' } }, upgradable: true },
    practice: null,
  });
});

describe('FitScore', () => {
  it('AI score: "74 / 100", the permanent line, the summary with the AI badge and the AI-written line', () => {
    renderWithProviders(<FitScore fit={fit()} />);
    expect(screen.getByText('74 / 100 — how well your resume lines up with this job post')).toBeInTheDocument();
    expect(screen.getByText('Good fit')).toBeInTheDocument();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.getByText(/Your payments work lines up well/)).toBeInTheDocument();
    expect(screen.getByTestId('ai-badge')).toHaveTextContent('AI-text');
    expect(screen.getByText(AI_LINE)).toBeInTheDocument();
    expect(screen.queryByText('Quick estimate')).not.toBeInTheDocument();
  });

  it('pre-score: labelled "Quick estimate" with its reason; no AI badge; the line stays', () => {
    renderWithProviders(<FitScore fit={fit({ kind: 'pre', summary: null, estimateReason: 'ai_off' })} />);
    expect(screen.getByText('Quick estimate')).toBeInTheDocument();
    expect(screen.getByText(/AI is turned off for your account/)).toBeInTheDocument();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByTestId('ai-badge')).not.toBeInTheDocument();
  });

  it('unknown score: "—", never 0, and the line still renders', () => {
    renderWithProviders(<FitScore fit={fit({ score: null, tier: null, kind: 'pre', summary: null })} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 100/)).not.toBeInTheDocument();
  });
});

describe('DimensionList — "What we compared"', () => {
  it('lists the five parts in published order with weights, scores, evidence and "not enough"', () => {
    renderWithProviders(<DimensionList dimensions={DIMS} />);
    expect(screen.getByRole('heading', { name: 'What we compared' })).toBeInTheDocument();
    const parts = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-part'));
    expect(parts.map((p) => p.getAttribute('data-part'))).toEqual(['title_level', 'skills', 'industry', 'logistics', 'career_path']);
    const title = parts[0]!;
    expect(within(title).getByText('The job title and level')).toBeInTheDocument();
    expect(within(title).getByText('50 / 100 · Weight 35')).toBeInTheDocument();
    expect(within(title).getByRole('meter')).toHaveAttribute('aria-valuenow', '50');
    expect(within(title).getByText('Job title: Backend Engineer')).toBeInTheDocument();
    expect(within(title).getByText('Level: Senior')).toBeInTheDocument();
    expect(within(title).getByText("They ask for: Master's degree")).toBeInTheDocument();
    expect(within(parts[1]!).getByText("They ask for Kubernetes, and your resume doesn't mention it")).toBeInTheDocument();
    expect(within(parts[2]!).getByText('“Built payment APIs”')).toBeInTheDocument();
    expect(within(parts[2]!).getByText('From your resume')).toBeInTheDocument();
    expect(within(parts[3]!).getByText('The listed pay is below your minimum: EUR 70000–90000')).toBeInTheDocument();
    // Estimate v2: a part that cannot be compared counts at the market's typical value in a quick estimate
    // (and is left out only in an AI fit), so the line makes no claim about the score.
    expect(within(parts[4]!).getByText('Not enough to compare.')).toBeInTheDocument();
    expect(within(parts[4]!).queryByText(/count toward the score/)).not.toBeInTheDocument();
    expect(within(parts[4]!).queryByRole('meter')).not.toBeInTheDocument();
  });

  // MKT-1F: a quick estimate does not compare a logistics part that only repeats the person's own filters. The
  // server sends it as not stated (no number) with one line under the ref `logistics_by_your_filters`.
  it('a logistics part that only repeats your filters shows no number and says why, with the post\'s own words', () => {
    const byFilters: MatchDimension[] = [
      { key: 'logistics', weight: 10, score: null, status: 'not_stated', evidence: [{ text: 'Austin, TX · USD 120,000–150,000 a year', source: 'posting', ref: 'logistics_by_your_filters' }] },
    ];
    renderWithProviders(<DimensionList dimensions={byFilters} />);
    const part = screen.getAllByRole('listitem').find((li) => li.getAttribute('data-part') === 'logistics')!;
    expect(within(part).getByText('These already match the filters you set, so they do not change the score: Austin, TX · USD 120,000–150,000 a year')).toBeInTheDocument();
    expect(within(part).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(part).getByText('Not enough to compare.')).toBeInTheDocument();
    expect(within(part).queryByText(/count toward the score/)).not.toBeInTheDocument();
    // Never the plain-quote fallback for this ref.
    expect(within(part).queryByText('“Austin, TX · USD 120,000–150,000 a year”')).not.toBeInTheDocument();
  });
});

describe('WhyYouFit / WhatYoureMissing', () => {
  it('shows the gap as plainly as the overlap, with the required heading', () => {
    renderWithProviders(
      <>
        <WhyYouFit strengths={['Your payment APIs in Go']} aligned={['TypeScript']} />
        <WhatYoureMissing gaps={['No Kubernetes work shown']} missing={['Kubernetes', 'Helm']} />
      </>,
    );
    expect(screen.getByRole('heading', { name: 'Why you fit' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "What you're missing" })).toBeInTheDocument();
    expect(screen.getByText("The post lists these, and your resume and profile don't mention them:")).toBeInTheDocument();
    expect(screen.getByText('Helm')).toBeInTheDocument();
    expect(screen.getAllByTestId('ai-badge')).toHaveLength(2);
    expect(screen.getAllByText(AI_LINE)).toHaveLength(2);
  });

  it('deterministic chips alone carry no AI label; empty states are plain', () => {
    renderWithProviders(
      <>
        <WhyYouFit strengths={[]} aligned={[]} />
        <WhatYoureMissing gaps={[]} missing={['Kubernetes']} />
      </>,
    );
    expect(screen.queryByTestId('ai-badge')).not.toBeInTheDocument();
    expect(screen.getByText('None of the skills this post lists show up in your resume or profile.')).toBeInTheDocument();
  });

  it('a post that lists no skills says so instead of claiming a match or a miss', () => {
    renderWithProviders(
      <>
        <WhyYouFit strengths={[]} aligned={[]} listed={0} />
        <WhatYoureMissing gaps={[]} missing={[]} listed={0} />
      </>,
    );
    expect(screen.getByText("This post doesn't list specific skills to compare.")).toBeInTheDocument();
    expect(screen.getByText("This post doesn't list specific skills to check.")).toBeInTheDocument();
    expect(screen.queryByText('Your resume or profile mentions every skill this post lists.')).not.toBeInTheDocument();
  });
});

describe('JobFitView chips', () => {
  it('uses the complete deterministic split, not the 1–2 evidence lines, plus verified AI terms', () => {
    // The skills evidence names only TypeScript / Kubernetes; the split has Go too.
    renderWithProviders(<JobFitView fit={fit({ keywordsMatched: ['PostgreSQL'], keywordsMissing: ['Helm'] })} />);
    const why = screen.getByTestId('fit-why');
    for (const s of ['TypeScript', 'Go', 'PostgreSQL']) expect(within(why).getByText(s)).toBeInTheDocument();
    const missing = screen.getByTestId('fit-missing');
    for (const s of ['Kubernetes', 'Helm']) expect(within(missing).getByText(s)).toBeInTheDocument();
  });

  it('an AI fit with no strengths, gaps or keywords never claims a perfect skills match it did not check', () => {
    renderWithProviders(<JobFitView fit={fit({ strengths: [], gaps: [], keywordsMissing: [], skills: { aligned: ['TypeScript'], missing: ['Kubernetes'], listed: 2 } })} />);
    expect(screen.queryByText('Your resume or profile mentions every skill this post lists.')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('fit-missing')).getByText('Kubernetes')).toBeInTheDocument();
    expect(within(screen.getByTestId('fit-why')).getByText('TypeScript')).toBeInTheDocument();
  });
});

describe('KeywordCheck', () => {
  const rows: KeywordRow[] = [
    { key: 'title', status: 'met', need: 'Backend Engineer', have: 'Software Engineer', found: null, total: null, items: [] },
    { key: 'years', status: 'unknown', need: 5, have: null, found: null, total: null, items: [] },
    { key: 'education', status: 'not_stated', need: null, have: 'bachelor', found: null, total: null, items: [] },
    { key: 'skills', status: 'partly', need: null, have: null, found: 1, total: 2, items: [{ term: 'TypeScript', found: true, required: true }, { term: 'Kubernetes', found: false, required: true }] },
    { key: 'keywords', status: 'not_met', need: null, have: null, found: 0, total: 1, items: [{ term: 'gRPC', found: false }] },
  ];

  it('renders one row per requirement with plain statuses and counts', () => {
    renderWithProviders(<KeywordCheck rows={rows} />);
    expect(screen.getByRole('heading', { name: 'Keyword check' })).toBeInTheDocument();
    const byRow = (k: string) => document.querySelector(`[data-row="${k}"]`) as HTMLElement;
    expect(within(byRow('title')).getByText('Met')).toBeInTheDocument();
    expect(within(byRow('title')).getByText('The post: Backend Engineer')).toBeInTheDocument();
    expect(within(byRow('years')).getByText('Not shown on your resume')).toBeInTheDocument();
    expect(within(byRow('years')).getByText('They ask for 5+ years')).toBeInTheDocument();
    expect(within(byRow('education')).getByText('Not stated in the post')).toBeInTheDocument();
    expect(within(byRow('skills')).getByText('1 of 2 shown by your resume')).toBeInTheDocument();
    expect(within(byRow('skills')).getByLabelText('Kubernetes: Not mentioned in your resume (Required)')).toBeInTheDocument();
    expect(within(byRow('keywords')).getByText('Not met')).toBeInTheDocument();
  });
});

describe('FIX-3: the keyword check', () => {
  it('says what counted when a broader term is met by something the resume names', () => {
    renderWithProviders(
      <KeywordCheck
        rows={[
          {
            key: 'skills',
            status: 'partly',
            need: null,
            have: null,
            found: 2,
            total: 3,
            items: [
              { term: 'Relational databases', found: true, via: 'PostgreSQL' },
              { term: 'TypeScript', found: true },
              { term: 'Kubernetes', found: false },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByLabelText('Relational databases: your resume shows PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('from PostgreSQL')).toBeInTheDocument();
    expect(screen.getByLabelText('TypeScript: Mentioned in your resume')).toBeInTheDocument();
    expect(screen.getByLabelText('Kubernetes: Not mentioned in your resume')).toBeInTheDocument();
  });

  it('the same words on both sides (本科 asked, 本科 held) and a repeated term do not collide as React keys', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWithProviders(
        <KeywordCheck
          rows={[
            { key: 'education', status: 'met', need: '本科', have: '本科', found: null, total: null, items: [] },
            { key: 'keywords', status: 'met', need: null, have: null, found: 2, total: 2, items: [{ term: 'Go', found: true }, { term: 'Go', found: true }] },
          ]}
        />,
      );
      expect(screen.getAllByText('本科')).toHaveLength(2);
      expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('same key'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('prints its title once: a caller with its own "Keyword check" heading turns the inner one off', () => {
    renderWithProviders(
      <section aria-label="outer">
        <h3>Keyword check</h3>
        <KeywordCheck rows={[]} withHeading={false} />
      </section>,
    );
    expect(screen.getAllByText('Keyword check')).toHaveLength(1);
    expect(screen.getByTestId('fit-keyword-check')).toHaveAccessibleName('Keyword check');
  });

  it('one chip per term on the fit card, and nothing the resume shows is also listed as missing', () => {
    const view = fit({
      skills: { aligned: ['TypeScript', 'Node.js'], missing: ['Kubernetes'], listed: 3 },
      keywordsMatched: ['typescript', 'NodeJS', 'Payments'],
      keywordsMissing: ['kubernetes', 'node.js', 'gRPC'],
    });
    renderWithProviders(<JobFitView fit={view} />);
    const chips = (id: string) => Array.from(screen.getByTestId(id).querySelectorAll('li[class*="chip"]')).map((li) => li.textContent?.replace('✓', '').trim());
    expect(chips('fit-why')).toEqual(['TypeScript', 'Node.js', 'Payments']);
    expect(chips('fit-missing')).toEqual(['Kubernetes', 'gRPC']);
    expect(uniq(['Go', 'go ', 'GO', 'Rust'])).toEqual(['Go', 'Rust']);
  });

  it('a stored quote is shown without the markdown of the resume it was read from', () => {
    renderWithProviders(
      <DimensionList
        dimensions={[
          { key: 'skills', weight: 30, score: 70, status: 'scored', evidence: [{ text: '**Technical:** TypeScript, Go', source: 'resume' }, { text: '- Led the rewrite of the ingestion service', source: 'resume' }] },
        ]}
      />,
    );
    expect(screen.getByText('“Technical: TypeScript, Go”')).toBeInTheDocument();
    expect(screen.getByText('“Led the rewrite of the ingestion service”')).toBeInTheDocument();
    expect(plainQuote('1. Shipped `v2` of the [API](https://x.test)')).toBe('Shipped v2 of the API');
  });
});

describe('FIX-3: fit text written in another language is marked, and can be rewritten', () => {
  it('says so and offers the rewrite; a text in the reader\'s language shows nothing', () => {
    const run = vi.fn();
    const stale = renderWithProviders(<JobFitView fit={fit({ summaryLocaleStale: true })} rewrite={{ run, pending: false, failed: false }} />);
    expect(screen.getByTestId('fit-other-language')).toHaveTextContent('The written parts of this analysis are in another language. The score is the same.');
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite them in this language' }));
    expect(run).toHaveBeenCalledTimes(1);
    stale.unmount();
    const busy = renderWithProviders(<JobFitView fit={fit({ summaryLocaleStale: true })} rewrite={{ run, pending: true, failed: true }} />);
    expect(screen.getByRole('button', { name: 'Rewriting…' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't rewrite it. Try again.");
    busy.unmount();
    renderWithProviders(<JobFitView fit={fit()} rewrite={{ run, pending: false, failed: false }} />);
    expect(screen.queryByTestId('fit-other-language')).toBeNull();
  });

  it('a quick estimate has no written parts, so nothing is marked', () => {
    renderWithProviders(<JobFitView fit={fit({ kind: 'pre', summary: null, strengths: [], gaps: [], summaryLocaleStale: true })} />);
    expect(screen.queryByTestId('fit-other-language')).toBeNull();
  });
});

describe('FIX-3: GoApply names no visa in the fit breakdown', () => {
  it('the logistics part is "Location and pay" on GoApply and keeps its name on RoboApply', () => {
    const dims: MatchDimension[] = [{ key: 'logistics', weight: 10, score: 100, status: 'scored', evidence: [{ text: '18-28K·15薪', source: 'posting', ref: 'pay_met' }] }];
    const cn = renderWithBrand(<DimensionList dimensions={dims} />, { brand: 'goapply' });
    expect(screen.getByText('Location and pay')).toBeInTheDocument();
    expect(screen.queryByText(/visa/i)).toBeNull();
    expect(screen.getByText(/18-28K·15薪/)).toBeInTheDocument();
    cn.unmount();
    renderWithProviders(<DimensionList dimensions={dims} />);
    expect(screen.getByText('Location, pay, and visa')).toBeInTheDocument();
  });
});

describe('FitAnalysisView', () => {
  it('shows the card with the education comparison and the credit note', () => {
    renderWithProviders(<FitAnalysisView card={CARD} />);
    expect(screen.getByRole('heading', { name: 'Fit analysis' })).toBeInTheDocument();
    expect(screen.getByText('Used 1 fit analysis.')).toBeInTheDocument();
    expect(screen.getAllByText("They ask for: Master's degree")).toHaveLength(2); // education block + title part
    expect(screen.getByText('You have: BSc Computer Science')).toBeInTheDocument();
    expect(screen.getByText('This is below what they ask for.')).toBeInTheDocument();
    expect(screen.getAllByText(LINE).length).toBeGreaterThan(0);
  });

  it('a free quick-estimate card has no AI text and no credit note', () => {
    renderWithProviders(<FitAnalysisView card={{ ...CARD, kind: 'pre', summary: null, highlights: [], gaps: [], aiWritten: false, charged: false, estimateReason: 'no_resume' }} />);
    expect(screen.getByText('Quick estimate')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-badge')).not.toBeInTheDocument();
    expect(screen.queryByText('Used 1 fit analysis.')).not.toBeInTheDocument();
  });
});

describe('FitAnalysisCard (connected)', () => {
  it('runs through the credit gate with an idempotency key and shows the result', async () => {
    api.getFitAnalysis.mockResolvedValue(CARD);
    renderWithProviders(<FitAnalysisCard jobId="job1" />);
    await waitFor(() => expect(screen.getByText(/Uses 1 of your 9 left/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Get the full fit analysis' }));
    await waitFor(() => expect(screen.getByTestId('fit-analysis')).toBeInTheDocument());
    expect(api.getFitAnalysis).toHaveBeenCalledWith('job1', {}, { idempotencyKey: expect.any(String) });
  });

  it('says nothing was charged when the analysis is unavailable', async () => {
    api.getFitAnalysis.mockRejectedValue(new RoboApiError('x', { status: 503, payload: { code: 'ai_unavailable' } }));
    renderWithProviders(<FitAnalysisCard jobId="job1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Get the full fit analysis' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Nothing was charged'));
  });

  it('opens the out-of-credits state on 402', async () => {
    api.getFitAnalysis.mockRejectedValue(new RoboApiError('x', { status: 402, payload: { code: 'credits_exhausted', details: { bucket: 'fit_analysis', upgradable: true } } }));
    renderWithProviders(<FitAnalysisCard jobId="job1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Get the full fit analysis' }));
    await waitFor(() => expect(screen.getByText("You've used today's fit analyses.")).toBeInTheDocument());
  });
});

describe('JobFit (connected)', () => {
  it('loads the fit through scoreJob and renders score, overlap, gap and parts', async () => {
    api.scoreJob.mockResolvedValue({ fit: fit() });
    renderWithProviders(<JobFit jobId="job1" />);
    await waitFor(() => expect(screen.getByTestId('job-fit')).toBeInTheDocument());
    expect(api.scoreJob).toHaveBeenCalledWith('job1', {}, expect.anything());
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Helm')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What we compared' })).toBeInTheDocument();
  });

  it('shows the honesty line while loading and a retry on error', async () => {
    api.scoreJob.mockRejectedValue(new RoboApiError('x', { status: 501, payload: { code: 'not_implemented' } }));
    renderWithProviders(<JobFit jobId="job1" />);
    expect(screen.getByText(LINE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load the fit"));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
