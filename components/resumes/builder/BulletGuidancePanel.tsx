'use client';

// BulletGuidancePanel — the right-pane companion that pops in while a bullet
// composer is active. Four tabs mirroring Teal's "Bullet Score" guidance:
//
//   1. Suggestions — bullet-writing best practices
//   2. Assistant   — fill-in-the-blank dropdowns that build the start of a
//                    quantified achievement phrase
//   3. Examples    — sample bullets the user can click to insert
//   4. Prompts     — "Did you …?" questions to spark ideas
//
// The panel calls `onInsert(text)` whenever the user picks something they
// want to drop into the composer. The parent forwards that to the composer's
// imperative handle.

import { useMemo, useState } from 'react';
import {
  ClipboardDocumentCheckIcon,
  PencilSquareIcon,
  CommandLineIcon,
  ListBulletIcon,
} from '@heroicons/react/24/outline';
import { cn } from '../../../lib/utils';

type Tab = 'suggestions' | 'assistant' | 'examples' | 'prompts';

const TABS: { id: Tab; label: string; Icon: typeof PencilSquareIcon }[] = [
  { id: 'suggestions', label: 'Suggestions', Icon: ClipboardDocumentCheckIcon },
  { id: 'assistant', label: 'Assistant', Icon: PencilSquareIcon },
  { id: 'examples', label: 'Examples', Icon: ListBulletIcon },
  { id: 'prompts', label: 'Prompts', Icon: CommandLineIcon },
];

interface Props {
  /** "Work Experience > Bullets" path label shown above the content. */
  scopeLabel?: string;
  /** Push text into the parent composer. */
  onInsert: (text: string) => void;
  /** Optional remaining-credit count for the "Run Analysis" promo block. */
  bulletScoreCreditsRemaining?: number;
  bulletScoreCreditsTotal?: number;
}

export function BulletGuidancePanel({
  scopeLabel = 'Work Experience > Bullets',
  onInsert,
  bulletScoreCreditsRemaining = 1,
  bulletScoreCreditsTotal = 2,
}: Props) {
  const [tab, setTab] = useState<Tab>('suggestions');

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
      <BulletScoreCallout
        creditsRemaining={bulletScoreCreditsRemaining}
        creditsTotal={bulletScoreCreditsTotal}
      />

      <div className="rounded-md border border-ink-line-soft bg-white shadow-card">
        <div className="border-b border-ink-line-soft px-5 py-3">
          <p className="text-sm font-semibold text-accent-text">Guidance</p>
        </div>

        <div className="flex items-end gap-2 border-b border-ink-line-soft px-5" role="tablist">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 border-b-2 px-2 text-sm font-medium transition-colors',
                  active
                    ? 'border-accent-text text-accent-text'
                    : 'border-transparent text-ink-500 hover:text-ink-900',
                )}
              >
                <t.Icon className="h-4 w-4" aria-hidden="true" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className="px-5 py-5">
          <p className="mb-3 text-base font-semibold text-ink-900">
            <span className="text-ink-500">Work Experience</span>
            <span className="mx-2 text-ink-300">›</span>
            <span>Bullets</span>
          </p>
          {tab === 'suggestions' ? <SuggestionsTab /> : null}
          {tab === 'assistant' ? <AssistantTab onInsert={onInsert} /> : null}
          {tab === 'examples' ? <ExamplesTab onInsert={onInsert} /> : null}
          {tab === 'prompts' ? <PromptsTab onInsert={onInsert} /> : null}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Bullet Score callout
// ─────────────────────────────────────────────────────────────────────

function BulletScoreCallout({
  creditsRemaining,
  creditsTotal,
}: {
  creditsRemaining: number;
  creditsTotal: number;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-accent-200 bg-accent-50/60 p-4 shadow-card">
      <h2 className="text-lg font-semibold text-ink-900">Bullet Score</h2>
      <p className="mt-2 text-sm text-ink-700">
        Try this AI feature to see how this bullet stacks up against ATS-scored examples.
      </p>
      <button
        type="button"
        className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-md border border-amber-400 bg-amber-300 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-400"
      >
        Run Free Analysis ({creditsRemaining}/{creditsTotal})
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: Suggestions
// ─────────────────────────────────────────────────────────────────────

function SuggestionsTab() {
  return (
    <div className="text-sm text-ink-700">
      <p>
        Your Work Experience bullets should show your achievements — not just
        responsibilities. Think of each bullet as empirical proof that you
        have a skill or have done something specific.
      </p>
      <ul className="mt-3 list-disc space-y-2 pl-5 marker:text-ink-300">
        <li>
          Be choosy about what you include. Don't overload a single role with
          too many bullets — pick the strongest 3–5.
        </li>
        <li>
          Your most recent job should have the most achievements (3–5). Older
          roles can be tighter (0–3).
        </li>
        <li>
          Use action verbs in the past tense to describe what you did.
        </li>
        <li>
          Include keywords and skills directly from the job posting in your
          achievements.
        </li>
        <li>
          Try our simple formula:{' '}
          <em className="font-semibold text-ink-900">
            success verb + noun + metric + outcome
          </em>
          .
        </li>
      </ul>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-500">
        Examples of achievements
      </p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 italic text-ink-700 marker:text-ink-300">
        <li>Organized a sold out charity event for 300 people and raised $500,000.</li>
        <li>
          Conducted compliance training for 100+ managers virtually across five
          locations that reduced company costs by 50%.
        </li>
        <li>
          Implemented new payroll and tax accounting systems that saved firm
          $2 million over 5 years.
        </li>
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: Assistant — dropdown phrase builder
// ─────────────────────────────────────────────────────────────────────

const ACTION_VERBS = [
  'Increased',
  'Reduced',
  'Built',
  'Launched',
  'Led',
  'Designed',
  'Delivered',
  'Owned',
  'Improved',
  'Migrated',
  'Scaled',
  'Saved',
];

const ACTION_NOUNS = [
  'revenue',
  'engagement',
  'user retention',
  'conversion rate',
  'latency',
  'costs',
  'team velocity',
  'error rate',
  'customer satisfaction',
  'time-to-ship',
  'sign-ups',
  'monthly active users',
];

const METRIC_AMOUNTS = [
  '10%',
  '25%',
  '50%',
  '2x',
  '3x',
  '100+',
  '$500K',
  '$1M',
  '$5M',
];

const TIME_SPANS = [
  'in 30 days',
  'in 3 months',
  'in 6 months',
  'in one quarter',
  'in 1 year',
  'over 2 years',
];

const STRATEGY_CONNECTORS = ['by', 'through', 'via', 'using'];

function AssistantTab({ onInsert }: { onInsert: (text: string) => void }) {
  const [verb, setVerb] = useState('');
  const [noun, setNoun] = useState('');
  const [amount, setAmount] = useState('');
  const [timeSpan, setTimeSpan] = useState('');
  const [connector, setConnector] = useState('');
  const [strategy, setStrategy] = useState('');

  const result = useMemo(() => {
    if (!verb && !noun && !amount && !strategy) return '';
    const parts: string[] = [];
    if (verb) parts.push(verb);
    if (noun) parts.push(noun);
    if (amount) parts.push(`by ${amount}`);
    if (timeSpan) parts.push(timeSpan);
    if (connector && strategy) parts.push(`${connector} ${strategy}`);
    else if (strategy) parts.push(strategy);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }, [verb, noun, amount, timeSpan, connector, strategy]);

  function reset() {
    setVerb('');
    setNoun('');
    setAmount('');
    setTimeSpan('');
    setConnector('');
    setStrategy('');
  }

  return (
    <div className="text-sm text-ink-700">
      <p>
        Use the dropdowns below to create the start of an effective achievement
        phrase. You can edit the result before saving.
      </p>

      <div className="mt-4">
        <p className="text-sm font-semibold text-ink-900">1. What did you do?</p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <DropdownSelect
            value={verb}
            onChange={setVerb}
            options={ACTION_VERBS}
            placeholder="Choose an action"
          />
          <DropdownSelect
            value={noun}
            onChange={setNoun}
            options={ACTION_NOUNS}
            placeholder="Choose a noun"
          />
        </div>
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold text-ink-900">
          2. What metric did you improve and in what time span?
        </p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <DropdownSelect
            value={amount}
            onChange={setAmount}
            options={METRIC_AMOUNTS}
            placeholder="Choose a metric"
          />
          <DropdownSelect
            value={timeSpan}
            onChange={setTimeSpan}
            options={TIME_SPANS}
            placeholder="Choose a time span"
          />
        </div>
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold text-ink-900">
          3. Connect your action to your strategy.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <DropdownSelect
            value={connector}
            onChange={setConnector}
            options={STRATEGY_CONNECTORS}
            placeholder="Choose one"
          />
          <input
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            placeholder="Type something…"
            className="h-10 rounded-md border border-ink-line bg-white px-3 text-sm text-ink-900 placeholder:text-ink-300 focus:border-accent-text focus:outline-none focus:shadow-focus"
          />
        </div>
      </div>

      <div className="mt-5 border-t border-ink-line-soft pt-4">
        <p className="text-sm font-semibold text-ink-900">The Result</p>
        {result ? (
          <p className="mt-2 rounded-md bg-bg-muted px-3 py-2 text-sm text-ink-900">
            {result}
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-300">
            The start of your achievement phrase will appear here after you
            make your selections.
          </p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-9 items-center rounded-md border border-ink-line bg-white px-3 text-sm font-semibold text-ink-700 transition-colors hover:bg-bg-muted"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => {
            if (result) onInsert(result);
          }}
          disabled={!result}
          className="inline-flex h-9 items-center rounded-md border border-accent-700 bg-accent-700 px-3 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-600 disabled:cursor-not-allowed disabled:bg-ink-line disabled:border-ink-line"
        >
          Insert into composer
        </button>
      </div>
    </div>
  );
}

function DropdownSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-10 rounded-md border bg-white px-3 text-sm text-ink-900 transition-colors focus:outline-none focus:shadow-focus',
        value ? 'border-ink-line text-ink-900' : 'border-ink-line text-ink-300',
      )}
    >
      <option value="">{placeholder}</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: Examples
// ─────────────────────────────────────────────────────────────────────

const EXAMPLES: string[] = [
  'Increased website visitors by 132% in 3 months by planning and launching an influencer campaign',
  'Grew TikTok views from 200 to 2,000 per video in 4 weeks resulting in adding 10,000 new followers',
  'Drove [company] brand awareness to prospective members, converting leads to future members, and ultimately laying the groundwork for member retention.',
  'Deployed and managed new CRM implementation and increased retention by 23%.',
  'Led a team of 5 people that grew member engagement by 90% in 12 months.',
  'Increased website conversion rate 35% by developing a digital marketing strategy.',
  'Increased new user activation 25% by redesigning product onboarding flow',
  'Reduced code review time by 30% a week by deploying new systems and process which lead to a 20% productivity gain for the engineering team.',
];

function ExamplesTab({ onInsert }: { onInsert: (text: string) => void }) {
  return (
    <div>
      <p className="mb-3 text-sm text-ink-500">
        Click any example to drop it into the composer — then edit it to match
        your actual numbers.
      </p>
      <ul className="space-y-1.5">
        {EXAMPLES.map((ex, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onInsert(ex)}
              className="group flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-2 text-left text-sm text-ink-700 transition-colors hover:border-accent-200 hover:bg-accent-50/40"
            >
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-300 group-hover:bg-accent-700"
                aria-hidden="true"
              />
              <span className="flex-1">{ex}</span>
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-accent-text opacity-0 transition-opacity group-hover:opacity-100">
                Insert
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tab: Prompts
// ─────────────────────────────────────────────────────────────────────

const PROMPTS: string[] = [
  'Did you make the company money?',
  'Did you save the company money?',
  'Did you make a process better?',
  'Did you make a process faster?',
  'Did you implement a new procedure or system?',
  'Did you solve a major problem for your section, department or division?',
  'Did you implement a better or more efficient way of doing a procedure?',
  'Did you train/mentor/manage anyone?',
  'Did you develop or do something for the first time at your company?',
  'Did you do a job with fewer people or in a shorter time?',
  'Did you suggest or "roll out" any new products or programs for your company?',
  'Did you increase market share?',
  'Did you develop new business or enlarge a market?',
  'Did you reduce errors?',
  'Did you improve employee performance?',
];

function PromptsTab({ onInsert }: { onInsert: (text: string) => void }) {
  return (
    <div>
      <p className="mb-3 text-sm text-ink-500">
        Use these prompts to find an angle you forgot. Click one to seed the
        composer with the question — then answer it in your bullet.
      </p>
      <ul className="space-y-1">
        {PROMPTS.map((p, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onInsert(p)}
              className="group flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm text-ink-700 transition-colors hover:border-accent-200 hover:bg-accent-50/40"
            >
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-300 group-hover:bg-accent-700"
                aria-hidden="true"
              />
              <span>{p}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
