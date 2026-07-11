// Mock-interview REPORT sections (v3) — RecommendationsCard +
// QuestionBreakdownSection. Verifies the new localized report sections render
// their LLM content (via the sanitized Markdown primitive), resolve their
// ie.report.* i18n keys against the real en bundle, and handle the
// pending/unavailable states.

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { IntlWrapper } from '../utils/mockTranslations';
import { RecommendationsCard } from '../../components/v3/mock/RecommendationsCard';
import { QuestionBreakdownSection } from '../../components/v3/mock/QuestionBreakdownSection';
import { TranscriptViewer, groupTranscript } from '../../components/v3/mock/TranscriptViewer';
import type {
  IERecommendation,
  IEQuestionAnalysisItem,
  IETranscriptTurn,
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
  intent: 'They want to see you weigh trade-offs under constraints, not recall a definition.',
  answerSummary: 'Chose Postgres over Mongo for the billing service.',
  keyQuote: 'we just went with what we knew',
  analysis: 'You named the choice but not the tradeoffs you weighed.',
  correction: 'You never said what alternatives you rejected or why.',
  suggestion: 'Name 2 options, the deciding criterion, and the outcome.',
  modelAnswer: 'A strong answer contrasts Postgres vs Mongo on consistency needs.',
  tips: ['Name the two options you compared', 'Cite one metric that drove the call'],
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
    expect(screen.getByText('Why they asked this')).toBeInTheDocument();
    expect(screen.getByText('Analysis')).toBeInTheDocument();
    expect(screen.getByText('What to fix')).toBeInTheDocument();
    expect(screen.getByText('How to improve')).toBeInTheDocument();
    expect(screen.getByText('Pro tips')).toBeInTheDocument();
    expect(screen.getByText('Model answer')).toBeInTheDocument();
    // the user's asks render their LLM content: intent, feedback, tips
    expect(screen.getByText(/weigh trade-offs under constraints/i)).toBeInTheDocument();
    expect(screen.getByText(/never said what alternatives/i)).toBeInTheDocument();
    expect(screen.getByText(/Name 2 options/i)).toBeInTheDocument();
    expect(screen.getByText(/Cite one metric that drove the call/i)).toBeInTheDocument();
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

const TURNS: IETranscriptTurn[] = [
  { role: 'interviewer', text: 'Tell me about yourself.', ts: 1 },
  { role: 'candidate', text: 'I am a full-stack engineer.', ts: 2 },
  { role: 'candidate', text: 'partial…', ts: 3, interim: true }, // dropped
  { role: 'interviewer', text: 'What was your hardest bug?', ts: 4 },
  { role: 'candidate', text: 'A race condition in checkout.', ts: 5 },
];

describe('groupTranscript', () => {
  it('groups turns into (interviewer prompt → answer) exchanges and drops interim', () => {
    const ex = groupTranscript(TURNS);
    expect(ex).toHaveLength(2);
    expect(ex[0].interviewer).toEqual(['Tell me about yourself.']);
    expect(ex[0].candidate).toEqual(['I am a full-stack engineer.']); // interim excluded
    expect(ex[1].interviewer).toEqual(['What was your hardest bug?']);
    expect(ex[1].candidate).toEqual(['A race condition in checkout.']);
  });

  it('returns [] when there are no usable turns', () => {
    expect(groupTranscript([])).toEqual([]);
    expect(groupTranscript([{ role: 'system', text: 'connected', ts: 1 }])).toEqual([]);
  });
});

describe('TranscriptViewer', () => {
  it('is collapsed by default, shows an exchange count, and expands on click', () => {
    render(
      <IntlWrapper>
        <TranscriptViewer turns={TURNS} transcriptUrl="https://example.com/t.txt" />
      </IntlWrapper>,
    );
    // Collapsed: toggle + count visible, verbatim turns hidden.
    expect(screen.getByRole('button', { name: /view transcript/i })).toBeInTheDocument();
    expect(screen.getByText('2 exchanges')).toBeInTheDocument();
    expect(screen.queryByText('A race condition in checkout.')).not.toBeInTheDocument();
    // Download affordance is present even while collapsed.
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', 'https://example.com/t.txt');

    fireEvent.click(screen.getByRole('button', { name: /view transcript/i }));

    // Expanded: verbatim turns + speaker labels render, toggle flips to Hide.
    expect(screen.getByRole('button', { name: /hide transcript/i })).toBeInTheDocument();
    expect(screen.getByText('A race condition in checkout.')).toBeInTheDocument();
    expect(screen.getByText('What was your hardest bug?')).toBeInTheDocument();
    expect(screen.queryByText('partial…')).not.toBeInTheDocument();
  });

  it('renders nothing when the transcript has no usable turns and no file', () => {
    const { container } = render(
      <IntlWrapper>
        <TranscriptViewer turns={[]} />
      </IntlWrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('still surfaces the Download link when a transcript file exists but has no groupable Q&A', () => {
    render(
      <IntlWrapper>
        <TranscriptViewer
          turns={[{ role: 'system', text: 'connected', ts: 1 }]}
          transcriptUrl="https://example.com/t.txt"
        />
      </IntlWrapper>,
    );
    // No exchanges to toggle, but the file is still downloadable.
    expect(screen.queryByRole('button', { name: /view transcript/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', 'https://example.com/t.txt');
  });
});
