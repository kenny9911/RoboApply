// PracticeSetupFlow — the plan dock and the prep brief of /practice.
//
// The dock shows the PLAN the prep agents wrote for the chosen job: chips for
// the interviewer, focus, format, length and language, each opening an inline
// tray of the plan's own alternatives (the recommended one badged "Suggested").
// Pinned here: "Preparing your interview" while the plan is written, the plan
// error with "Try again", a fallback plan labelled from the bundles, the
// 15/20/30-minute lengths priced in their tray, Start, and the prep brief
// (what the job tests, how the company interviews, how the practice runs, what
// to prepare; the AI label renders on GoApply only).

import type { ComponentProps, ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';

import {
  DEFAULT_PRACTICE_MINUTES,
  PRACTICE_DURATIONS,
  PracticeSetupFlow,
  practiceDurationOptions,
} from '../PracticeSetupFlow';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';
import { companyStyle, fallbackPlan, prepPlan } from '../../../../__tests__/utils/prepFixtures';

type FlowProps = ComponentProps<typeof PracticeSetupFlow>;

function renderFlow(overrides: Partial<FlowProps> = {}, brand: 'roboapply' | 'goapply' = 'roboapply') {
  const props: FlowProps = {
    targetSection: <div data-testid="target-section" />,
    hasRoleSource: true,
    effectiveRole: 'Backend Engineer',
    company: null,
    planState: 'ready',
    plan: prepPlan(),
    onRetryPlan: vi.fn(),
    selectedInterviewerKey: 'i1',
    onSelectInterviewer: vi.fn(),
    selectedFocusKey: 'f1',
    onSelectFocus: vi.fn(),
    format: 'video',
    onFormatChange: vi.fn(),
    language: 'en',
    onLanguageChange: vi.fn(),
    durationMinutes: 20,
    durationOptions: practiceDurationOptions({ id: 'system' }),
    onDurationChange: vi.fn(),
    recentSessions: [],
    onReplay: vi.fn(),
    onRepeat: vi.fn(),
    onDelete: vi.fn(),
    creditCost: 1,
    creditMinutes: 20,
    creditsRemaining: 5,
    canAfford: true,
    startError: null,
    insufficientCredits: null,
    canLaunch: true,
    starting: false,
    onStart: vi.fn(),
    ...overrides,
  };
  const ui: ReactElement = <PracticeSetupFlow {...props} />;
  const view = renderWithProviders(<BrandProvider brand={clientBrandFor(brand)}>{ui}</BrandProvider>);
  return { props, view };
}

/** A dock chip: its name is the label, the value and "Suggested" when the plan recommends it. */
const chip = (name: RegExp) => screen.getByRole('button', { name, expanded: false });
const start = () => screen.getByRole('button', { name: /^Start/ }) as HTMLButtonElement;

afterEach(() => {
  vi.useRealTimers();
});

describe('practice lengths', () => {
  it('are 15, 20 and 30 minutes (20 by default); the AI-interview format runs 20 or 30', () => {
    expect(PRACTICE_DURATIONS).toEqual([15, 20, 30]);
    expect(DEFAULT_PRACTICE_MINUTES).toBe(20);
    expect(practiceDurationOptions(null)).toEqual([15, 20, 30]);
    expect(practiceDurationOptions({ id: 'behavioral' })).toEqual([15, 20, 30]);
    expect(practiceDurationOptions({ id: 'cn_ai_interview' })).toEqual([20, 30]);
  });
});

describe('PracticeSetupFlow: the plan dock', () => {
  it('before a job is chosen: no plan, no brief, and Start waits for the job', () => {
    renderFlow({ hasRoleSource: false, effectiveRole: null, planState: 'idle', plan: null, canLaunch: false });
    expect(screen.getByTestId('target-section')).toBeInTheDocument();
    expect(screen.getByText('Pick a job above to begin.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your interview' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Your prep brief/ })).toBeNull();
    expect(start().disabled).toBe(true);
  });

  it('says it is preparing the interview, step by step, while the plan is written', () => {
    vi.useFakeTimers();
    renderFlow({ planState: 'loading', plan: null, company: 'Acme', canLaunch: false });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Preparing your interview');
    const steps = within(status).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Reading the job',
      'Researching how Acme interviews',
      'Choosing the interviewers for this job',
    ]);
    expect(steps.map((step) => step.dataset.state)).toEqual(['active', 'todo', 'todo']);
    act(() => { vi.advanceTimersByTime(7000); });
    expect(steps.map((step) => step.dataset.state)).toEqual(['done', 'active', 'todo']);
    // The last step stays active until the plan arrives.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(steps.map((step) => step.dataset.state)).toEqual(['done', 'done', 'active']);

    // Nothing to choose or read yet, and nothing to start.
    expect(screen.queryByRole('heading', { name: 'Your interview' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Interviewer/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Your prep brief/ })).toBeNull();
    expect(start().disabled).toBe(true);
    // The launch line already names the job and the company.
    expect(screen.getByText('Backend Engineer · Acme')).toBeInTheDocument();
  });

  it('without a company there is no company step; a job waiting on its plan reads as preparing too', () => {
    renderFlow({ planState: 'idle', plan: null, canLaunch: false });
    expect(within(screen.getByRole('status')).getAllByRole('listitem').map((step) => step.textContent)).toEqual([
      'Reading the job',
      'Choosing the interviewers for this job',
    ]);
  });

  it('a plan that failed says so and tries again on request', () => {
    const { props } = renderFlow({ planState: 'error', plan: null, canLaunch: false });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("We couldn't prepare this interview.");
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(props.onRetryPlan).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Your interview' })).toBeNull();
    expect(start().disabled).toBe(true);
  });

  it('shows the plan: the recommended interviewer and focus are preselected and marked Suggested', () => {
    renderFlow({ company: 'Acme' });
    expect(screen.getByRole('heading', { name: 'Your interview' })).toBeInTheDocument();
    expect(screen.getByText('Written for this job. Change anything.')).toBeInTheDocument();
    expect(chip(/^Interviewer\s*Dana Okafor\s*Suggested$/)).toBeInTheDocument();
    expect(chip(/^Focus\s*Payments system design\s*Suggested$/)).toBeInTheDocument();
    expect(chip(/^Format\s*Video$/)).toBeInTheDocument();
    expect(chip(/^Length\s*20 min$/)).toBeInTheDocument();
    expect(chip(/^Language\s*English$/)).toBeInTheDocument();
    expect(screen.getByText('Backend Engineer · Acme')).toBeInTheDocument();
    expect(screen.getByText('Costs 1 credit · 5 credits left')).toBeInTheDocument();
    expect(start().disabled).toBe(false);
  });

  it('a choice other than the recommendation is not marked Suggested', () => {
    renderFlow({ selectedInterviewerKey: 'i2', selectedFocusKey: 'f2' });
    expect(chip(/^Interviewer\s*Leo Martins$/)).toBeInTheDocument();
    expect(chip(/^Focus\s*Ownership stories$/)).toBeInTheDocument();
  });

  it('the interviewer tray lists the plan’s interviewers, the recommended first, and applies a choice', () => {
    const { props } = renderFlow();
    fireEvent.click(chip(/^Interviewer/));
    const tray = screen.getByRole('group', { name: 'Pick your interviewer' });
    const options = within(tray).getAllByRole('radio');
    expect(options.map((option) => option.querySelector('strong')?.textContent)).toEqual(['Dana Okafor', 'Leo Martins']);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    expect(options[0]).toHaveTextContent('Staff backend engineer · Demanding');
    expect(options[0]).toHaveTextContent('Digs into the decision behind every design');
    expect(options[0]).toHaveTextContent('Suggested');
    expect(options[1]).toHaveTextContent('Engineering manager · Balanced');
    expect(options[1]).not.toHaveTextContent('Suggested');

    fireEvent.click(options[1]);
    expect(props.onSelectInterviewer).toHaveBeenCalledWith('i2');
    // A choice closes the tray; the page owns the selection.
    expect(screen.queryByRole('group', { name: 'Pick your interviewer' })).toBeNull();
  });

  it('the focus tray floats the recommended focus to the front and shows what each covers', () => {
    const plan = prepPlan({ recommended: { interviewerKey: 'i2', focusKey: 'f2' } });
    const { props } = renderFlow({ plan, selectedInterviewerKey: 'i2', selectedFocusKey: 'f2' });
    fireEvent.click(chip(/^Focus/));
    const tray = screen.getByRole('group', { name: 'What should this interview cover?' });
    const options = within(tray).getAllByRole('radio');
    expect(options.map((option) => option.querySelector('strong')?.textContent)).toEqual([
      'Ownership stories',
      'Payments system design',
      'API coding',
    ]);
    expect(options[0]).toHaveTextContent('Suggested');
    expect(options[1]).toHaveTextContent('Design a payment ledger and defend the trade-offs');
    expect(options[1]).toHaveTextContent('Idempotency · Consistency');
    fireEvent.click(options[2]);
    expect(props.onSelectFocus).toHaveBeenCalledWith('f3');
  });

  it('a fallback plan is labelled from the bundles: the formats’ and personas’ own names', () => {
    renderFlow({ plan: fallbackPlan(), selectedInterviewerKey: 'i1', selectedFocusKey: 'f1' });
    expect(screen.getByText('General interviewers and formats for now. Change anything.')).toBeInTheDocument();
    expect(chip(/^Focus\s*Past situations\s*Suggested$/)).toBeInTheDocument();

    fireEvent.click(chip(/^Focus/));
    const focusTray = screen.getByRole('group', { name: 'What should this interview cover?' });
    expect(within(focusTray).getByRole('radio', { name: /^Past situations/ })).toHaveTextContent(
      'Real stories: ownership, conflict, failure, influence, leading people',
    );
    expect(within(focusTray).getByRole('radio', { name: /^Values and working style/ })).toBeInTheDocument();
    // The server's English catalog strings never reach the screen.
    expect(focusTray).not.toHaveTextContent('Behavioral (STAR)');
    expect(focusTray).not.toHaveTextContent('Culture & values');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(chip(/^Interviewer\s*Priya/));
    const interviewerTray = screen.getByRole('group', { name: 'Pick your interviewer' });
    expect(within(interviewerTray).getByRole('radio', { name: /^Priya/ })).toHaveTextContent('The behavior interviewer · Balanced');
    expect(within(interviewerTray).getByRole('radio', { name: /^Maya/ })).toHaveTextContent('The warm recruiter · Gentle');
    expect(interviewerTray).not.toHaveTextContent('The Behavioral Probe');
    // A fallback persona's catalog style line is not shown either.
    expect(interviewerTray).not.toHaveTextContent('STAR enforcement');
  });

  it('offers 15, 20 and 30 minutes, each priced, the ones the balance does not cover marked', () => {
    const { props } = renderFlow({ creditsRemaining: 1 });
    fireEvent.click(chip(/^Length\s*20 min/));
    const tray = screen.getByRole('group', { name: 'How long should it run?' });
    const options = within(tray).getAllByRole('radio');
    expect(options.map((option) => option.querySelector('strong')?.textContent)).toEqual(['15 min', '20 min', '30 min']);
    expect(options[0]).toHaveTextContent('Costs 0.75 credits');
    expect(options[1]).toHaveTextContent('Costs 1 credit');
    expect(options[1]).toHaveAttribute('aria-checked', 'true');
    expect(options[2]).toHaveTextContent('1.5 credits — more than you have');
    // Still selectable: the shortfall is explained after the choice, with a repair.
    fireEvent.click(options[2]);
    expect(props.onDurationChange).toHaveBeenCalledWith(30);
  });

  it('prices the lengths at the server’s minutes per credit', () => {
    renderFlow({ creditMinutes: 10, creditsRemaining: 2, creditCost: 2 });
    expect(screen.getByText('Costs 2 credits · 2 credits left')).toBeInTheDocument();
    fireEvent.click(chip(/^Length/));
    const options = within(screen.getByRole('group', { name: 'How long should it run?' })).getAllByRole('radio');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Costs 1.5 credits'),
      expect.stringContaining('Costs 2 credits'),
      expect.stringContaining('3 credits — more than you have'),
    ]);
  });

  it('the AI-interview format offers only its own lengths', () => {
    renderFlow({ durationOptions: practiceDurationOptions({ id: 'cn_ai_interview' }) });
    fireEvent.click(chip(/^Length/));
    const options = within(screen.getByRole('group', { name: 'How long should it run?' })).getAllByRole('radio');
    expect(options.map((option) => option.querySelector('strong')?.textContent)).toEqual(['20 min', '30 min']);
  });

  it('no Format chip where the practice runs in writing; Start can say so', () => {
    const { props } = renderFlow({ formatChoice: false, startLabel: 'Start the written practice' });
    expect(chip(/^Length/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Format/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start the written practice' }));
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  it('Start stays off without a plan to launch or credits to pay, and says when it is starting', () => {
    const noPlan = renderFlow({ canLaunch: false });
    expect(start().disabled).toBe(true);
    noPlan.view.unmount();
    const short = renderFlow({ canAfford: false });
    expect(start().disabled).toBe(true);
    short.view.unmount();
    renderFlow({ starting: true });
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
  });
});

describe('PracticeSetupFlow: the prep brief', () => {
  it('says what the job tests, how this practice will run and what to prepare', () => {
    renderFlow();
    const toggle = screen.getByRole('button', { name: /Your prep brief/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const brief = toggle.closest('section') as HTMLElement;

    expect(within(brief).getByRole('heading', { name: 'What this job tests' })).toBeInTheDocument();
    expect(brief).toHaveTextContent('Builds and runs the payment APIs.');
    expect(within(within(brief).getByRole('list', { name: 'Must-haves' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Go',
      'PostgreSQL',
    ]);
    expect(brief).toHaveTextContent('Payments system design covers: Idempotency · Consistency');

    expect(within(brief).getByRole('heading', { name: 'How this practice will run' })).toBeInTheDocument();
    expect(brief).toHaveTextContent('A short warm-up, then one deep design problem.');
    // Each stage's minutes come from its share of the length chosen (1 : 2 : 1 of 20 minutes).
    expect(brief).toHaveTextContent(/Warm-up\s*5 min/);
    expect(brief).toHaveTextContent(/Design\s*10 min/);
    expect(brief).toHaveTextContent(/Wrap-up\s*5 min/);
    expect(within(brief).getByRole('heading', { name: 'What your interviewer will do' })).toBeInTheDocument();
    expect(brief).toHaveTextContent('Asks for the number behind each claim');

    expect(within(brief).getByRole('heading', { name: 'Prepare before you start' })).toBeInTheDocument();
    expect(brief).toHaveTextContent('Have one outage story ready');
    expect(brief).toHaveTextContent('Written by AI from the job and public sources. The interviewers are simulated.');
    // No company named, no company section.
    expect(within(brief).queryByRole('heading', { name: /interviews$/ })).toBeNull();
  });

  it('the stage minutes follow the length chosen', () => {
    renderFlow({ durationMinutes: 30, creditCost: 1.5 });
    const brief = screen.getByRole('button', { name: /Your prep brief/ }).closest('section') as HTMLElement;
    expect(brief).toHaveTextContent(/Warm-up\s*8 min/);
    expect(brief).toHaveTextContent(/Design\s*15 min/);
  });

  it('how the company interviews, from public sources with the links', () => {
    renderFlow({ company: 'Acme', plan: prepPlan({ company: 'Acme', companyStyle: companyStyle() }) });
    const brief = screen.getByRole('button', { name: /Your prep brief/ }).closest('section') as HTMLElement;
    expect(within(brief).getByRole('heading', { name: 'How Acme interviews' })).toBeInTheDocument();
    expect(brief).toHaveTextContent('From public sources, summarized by AI. Processes change, so check the links.');
    expect(brief).toHaveTextContent('Acme runs a recruiter call, a technical screen and an onsite loop.');
    expect(brief).toHaveTextContent(/Recruiter call\s*Background and motivation/);
    expect(within(brief).getByRole('heading', { name: 'Values they assess' })).toBeInTheDocument();
    expect(brief).toHaveTextContent('Ownership');
    expect(within(brief).getByRole('heading', { name: 'What they look for' })).toBeInTheDocument();
    expect(brief).toHaveTextContent('Clear trade-offs');
    const source = within(brief).getByRole('link', { name: 'How Acme hires' });
    expect(source).toHaveAttribute('href', 'https://acme.example/hiring');
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('with no reliable public description it says so, and that this is how companies like it interview', () => {
    renderFlow({
      company: 'Tiny Co',
      plan: prepPlan({ company: 'Tiny Co', companyStyle: companyStyle({ company: 'Tiny Co', basis: 'general', sources: [], summary: 'Usually two rounds.' }) }),
    });
    const brief = screen.getByRole('button', { name: /Your prep brief/ }).closest('section') as HTMLElement;
    expect(within(brief).getByRole('heading', { name: 'How Tiny Co interviews' })).toBeInTheDocument();
    expect(brief).toHaveTextContent(
      "We found no reliable public description of Tiny Co's interviews, so this is how companies like it usually interview.",
    );
    expect(brief).not.toHaveTextContent('Sources:');
    expect(brief).not.toHaveTextContent('From public sources');
  });

  it('folds away and opens again', () => {
    renderFlow();
    const toggle = screen.getByRole('button', { name: /Your prep brief/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'What this job tests' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('heading', { name: 'What this job tests' })).toBeInTheDocument();
  });

  it('a plan with nothing to brief shows no brief', () => {
    renderFlow({
      plan: prepPlan({
        requirements: { summary: '', seniority: '', mustHave: [], niceToHave: [], responsibilities: [], competencies: [] },
        strategy: { summary: '', stages: [], tactics: [], prepTips: [] },
      }),
    });
    expect(screen.getByRole('heading', { name: 'Your interview' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Your prep brief/ })).toBeNull();
  });

  it('carries the AI-generated label on GoApply only', () => {
    const roboApply = renderFlow();
    expect(screen.getByRole('button', { name: /Your prep brief/ }).querySelector('[data-ai-label]')).toBeNull();
    roboApply.view.unmount();
    renderFlow({}, 'goapply');
    const toggle = screen.getByRole('button', { name: /Your prep brief/ });
    expect(toggle.querySelector('[data-ai-label="text"]')).toHaveTextContent('AI-generated');
  });
});
