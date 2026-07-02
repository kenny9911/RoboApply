'use client';

// BuilderJobMatcher — paste a JD, see keyword coverage + suggested bullets.
// Pure-client heuristic for now (tokenises the JD, intersects with the resume
// text). The real LLM-backed scorer will swap in here later.

import { useMemo, useState } from 'react';
import {
  SparklesIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import {
  serializeResumeMarkdown,
  type StructuredResume,
} from '../../../lib/resumeStructure';
import { aiGenerateBulletsFromJob } from '../../../lib/resumeAI';
import { cn } from '../../../lib/utils';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'with', 'you', 'your', 'will', 'have', 'has',
  'had', 'this', 'that', 'from', 'into', 'over', 'about', 'their', 'they',
  'them', 'who', 'what', 'when', 'where', 'why', 'how', 'our', 'team', 'role',
  'job', 'work', 'years', 'year', 'must', 'should', 'can', 'able', 'using',
  'use', 'be', 'is', 'a', 'an', 'or', 'of', 'in', 'on', 'to', 'as', 'at',
  'by', 'we', 'us', 'all', 'any', 'such', 'may', 'one', 'two', 'three',
  'four', 'five', 'including', 'plus', 'preferred', 'required',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s+/.#-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[.,]+$/, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function extractKeywords(jd: string): { token: string; freq: number }[] {
  const tokens = tokenize(jd);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([token, freq]) => ({ token, freq }))
    .filter((k) => k.freq >= 1 && k.token.length >= 3)
    .sort((a, b) => b.freq - a.freq)
    .slice(0, 30);
}

interface Props {
  resume: StructuredResume;
  onAddBullets?: (bullets: string[]) => void;
}

export function BuilderJobMatcher({ resume, onAddBullets }: Props) {
  const [jd, setJd] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<number>>(new Set());

  const resumeText = useMemo(
    () => serializeResumeMarkdown(resume).toLowerCase(),
    [resume],
  );

  const keywords = useMemo(() => (jd.trim() ? extractKeywords(jd) : []), [jd]);

  const matched = useMemo(
    () => keywords.filter((k) => resumeText.includes(k.token)),
    [keywords, resumeText],
  );
  const missing = useMemo(
    () => keywords.filter((k) => !resumeText.includes(k.token)),
    [keywords, resumeText],
  );

  const matchPct =
    keywords.length === 0 ? null : Math.round((matched.length / keywords.length) * 100);

  async function handleSuggestBullets() {
    setSuggesting(true);
    try {
      const out = await aiGenerateBulletsFromJob(jd);
      setSuggested(out);
      setPickedIds(new Set());
    } finally {
      setSuggesting(false);
    }
  }

  function togglePick(i: number) {
    const next = new Set(pickedIds);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setPickedIds(next);
  }

  function commitPicked() {
    if (!onAddBullets) return;
    const out = suggested.filter((_, i) => pickedIds.has(i));
    if (out.length === 0) return;
    onAddBullets(out);
    setPickedIds(new Set());
  }

  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5">
      <div className="rounded-md border border-ink-line-soft bg-white p-6 shadow-card">
        <h2 className="text-base font-semibold text-ink-900">Paste a job description</h2>
        <p className="mt-1 text-sm text-ink-500">
          We'll surface the keywords this role weights, and where your resume already covers them.
        </p>
        <textarea
          rows={8}
          value={jd}
          onChange={(e) => setJd(e.target.value)}
          placeholder="Paste the full job description here…"
          className="mt-4 w-full resize-y rounded-md border border-ink-line bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-accent-text focus:outline-none focus:shadow-focus"
        />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-500">
            {jd.trim().length === 0
              ? 'Paste a JD to see keyword coverage.'
              : `${keywords.length} keywords detected.`}
          </p>
          <button
            type="button"
            onClick={handleSuggestBullets}
            disabled={!jd.trim() || suggesting}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md border border-accent-600 bg-accent-600 px-4 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-700',
              'disabled:cursor-not-allowed disabled:bg-ink-line disabled:border-ink-line',
            )}
          >
            {suggesting ? (
              <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <SparklesIcon className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{suggesting ? 'Drafting…' : 'AI suggest bullets'}</span>
          </button>
        </div>
      </div>

      {matchPct !== null ? (
        <div className="rounded-md border border-ink-line-soft bg-white p-6 shadow-card">
          <div className="flex items-baseline justify-between">
            <h3 className="text-base font-semibold text-ink-900">Keyword coverage</h3>
            <span className="text-2xl font-bold text-accent-text">{matchPct}%</span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-ink-line-soft">
            <div
              className="h-full rounded-full bg-accent-600 transition-all duration-500"
              style={{ width: `${matchPct}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-success">
                <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
                Covered ({matched.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {matched.map((k) => (
                  <span
                    key={k.token}
                    className="inline-flex h-6 items-center rounded-full border border-success/30 bg-success/10 px-2 text-[11px] font-medium text-success"
                  >
                    {k.token}
                  </span>
                ))}
                {matched.length === 0 ? (
                  <span className="text-xs text-ink-500">None yet.</span>
                ) : null}
              </div>
            </div>
            <div>
              <p className="mb-2 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-danger">
                <XCircleIcon className="h-4 w-4" aria-hidden="true" />
                Missing ({missing.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((k) => (
                  <span
                    key={k.token}
                    className="inline-flex h-6 items-center rounded-full border border-danger/20 bg-danger/5 px-2 text-[11px] font-medium text-danger"
                  >
                    {k.token}
                  </span>
                ))}
                {missing.length === 0 ? (
                  <span className="text-xs text-ink-500">You've got everything.</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {suggested.length > 0 ? (
        <div className="rounded-md border border-ink-line-soft bg-white p-6 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-ink-900">
              AI-drafted bullets
              <span className="ml-2 text-xs font-medium text-ink-500">
                Pick the ones to add
              </span>
            </h3>
            <button
              type="button"
              onClick={commitPicked}
              disabled={pickedIds.size === 0 || !onAddBullets}
              className="inline-flex h-9 items-center gap-1 rounded-md border border-accent-600 bg-accent-600 px-3 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-700 disabled:cursor-not-allowed disabled:bg-ink-line disabled:border-ink-line"
            >
              Add {pickedIds.size > 0 ? `${pickedIds.size} ` : ''}to first experience
            </button>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {suggested.map((b, i) => {
              const picked = pickedIds.has(i);
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => togglePick(i)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      picked
                        ? 'border-accent-text bg-accent-50 text-ink-900'
                        : 'border-ink-line-soft bg-bg-muted/30 text-ink-700 hover:bg-bg-muted',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                        picked
                          ? 'border-accent-600 bg-accent-600 text-accent-ink'
                          : 'border-ink-line',
                      )}
                      aria-hidden="true"
                    >
                      {picked ? '✓' : ''}
                    </span>
                    <span>{b}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
