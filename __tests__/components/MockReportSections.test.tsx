// Mock-interview REPORT sections (v3) — RecommendationsCard +
// QuestionBreakdownSection. Verifies the new localized report sections render
// their LLM content (via the sanitized Markdown primitive), resolve their
// ie.report.* i18n keys against the real en bundle, and handle the
// pending/unavailable states.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { IntlWrapper } from '../utils/mockTranslations';
import { RecommendationsCard } from '../../components/v3/mock/RecommendationsCard';
import { QuestionBreakdownSection } from '../../components/v3/mock/QuestionBreakdownSection';
import type {
  IERecommendation,
  IEQuestionAnalysisItem,
} from '../../lib/api/interviewEngine';

const REC: IERecommendation = {
  title: 'Quantify your impact',
  priority: 'high',
  detail: 'You described the migration without a single metric.',
  example: 'Before: "we improved performance." After: "cut p95 latency 40% (820ms → 490ms)."',
  drill: 'Re-answer 3 stories in 90s each, one number per story.',
  linkedDimension: 'roleFit',
};

const QUESTION: IEQuestionAnalysisItem = {
  questionIndex: 0,
  blueprintIndex: 0,
  missed: false,
  question: 'Tell me about a hard technical decision.',
  answerSummary: 'Chose Postgres over Mongo for the billing service.',
  keyQuote: 'we just went with what we knew',
  analysis: 'You named the choice but not the tradeoffs you weighed.',
  correction: 'You never said what alternatives you rejected or why.',
  suggestion: 'Name 2 options, the deciding criterion, and the outcome.',
  modelAnswer: 'A strong answer contrasts Postgres vs Mongo on consistency needs.',
  rating: 'weak',
  score: 42,
  tags: ['no tradeoffs'],
};

describe('RecommendationsCard', () => {
  it('renders a recommendation with priority, example, drill, and dimension', () => {
    render(
      <IntlWrapper>
        <RecommendationsCard recommendations={[REC]} />
      </IntlWrapper>,
    );
    expect(screen.getByText('Action plan')).toBeInTheDocument();
    expect(screen.getByText('Quantify your impact')).toBeInTheDocument();
    expect(screen.getByText('High priority')).toBeInTheDocument();
    expect(screen.getByText(/single metric/i)).toBeInTheDocument();
    expect(screen.getByText('Example rewrite')).toBeInTheDocument();
    expect(screen.getByText('Drill')).toBeInTheDocument();
    expect(screen.getByText('Role fit')).toBeInTheDocument(); // linkedDimension label
  });

  it('shows the pending note when enrichment has not landed', () => {
    render(
      <IntlWrapper>
        <RecommendationsCard recommendations={null} enrichmentPending />
      </IntlWrapper>,
    );
    expect(screen.getByText(/action plan is being generated/i)).toBeInTheDocument();
  });

  it('shows the empty note for a flawless session', () => {
    render(
      <IntlWrapper>
        <RecommendationsCard recommendations={[]} />
      </IntlWrapper>,
    );
    expect(screen.getByText(/No recommendations/i)).toBeInTheDocument();
  });
});

describe('QuestionBreakdownSection', () => {
  it('renders a question with analysis / correction / suggestion / model answer', () => {
    render(
      <IntlWrapper>
        <QuestionBreakdownSection items={[QUESTION]} />
      </IntlWrapper>,
    );
    expect(screen.getByText('Question-by-question review')).toBeInTheDocument();
    expect(screen.getByText('Tell me about a hard technical decision.')).toBeInTheDocument();
    // section labels resolve from the ie.report.questionBreakdown.* bundle
    expect(screen.getByText('Analysis')).toBeInTheDocument();
    expect(screen.getByText('What to fix')).toBeInTheDocument();
    expect(screen.getByText('How to improve')).toBeInTheDocument();
    expect(screen.getByText('Model answer')).toBeInTheDocument();
    // the user's three asks render their LLM content
    expect(screen.getByText(/never said what alternatives/i)).toBeInTheDocument();
    expect(screen.getByText(/Name 2 options/i)).toBeInTheDocument();
    // rating chip
    expect(screen.getByText('Needs work')).toBeInTheDocument();
  });

  it('renders nothing for an empty array but shows the pending placeholder for null', () => {
    const { container, rerender } = render(
      <IntlWrapper>
        <QuestionBreakdownSection items={[]} />
      </IntlWrapper>,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <IntlWrapper>
        <QuestionBreakdownSection items={null} enrichmentPending />
      </IntlWrapper>,
    );
    expect(screen.getByText(/question review is being generated/i)).toBeInTheDocument();
  });
});
