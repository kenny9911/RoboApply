// server/src/features/match/eval/live/report.ts
//
// The dated report of a live run: report.md and report.json under
// eval/.snapshots/<yyyy-mm-dd>/ (git-ignored). It states the date, the model
// ids, the sample size of every metric, every gate with its status, and which
// labels each value was computed from (constructed, judged or human; never
// mixed inside one value).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JUDGE_TRUST_MIN_KAPPA, JUDGE_TRUST_MIN_PAIRS, type JudgeAudit } from '../gates.js';
import type { Report, ReportRow } from '../run.js';

export interface LiveReportMeta {
  date: string;
  takenAt: string;
  markets: string[];
  models: {
    judge: string | null;
    judgePromptVersion: string;
    /** Markets whose pairs the judge graded (a market is left out when the judge is that market's scorer). */
    judgedMarkets: string[];
    /** The scorer model each market resolved to, inside its own brand; null when none is configured. */
    scorer: Record<string, string | null>;
  };
  /** What was sampled and how many: personas, pooled postings, judged pairs, stability pairs. */
  samples: Array<{ what: string; n: number }>;
  audit: JudgeAudit | null;
  notes: string[];
}

function tableMd(rows: readonly ReportRow[]): string[] {
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  return ['| Layer | Metric | Value | Gate | Status |', '|---|---|---|---|---|', ...rows.map((r) => `| ${esc(r.layer)} | ${esc(r.metric)} | ${esc(r.value)} | ${esc(r.gate)} | ${r.status} |`)];
}

export function renderReportMd(meta: LiveReportMeta, report: Report): string {
  const kinds = new Map<string, number>();
  for (const r of report.rows) if (r.raw?.labels && r.raw.labels !== 'none') kinds.set(r.raw.labels, (kinds.get(r.raw.labels) ?? 0) + 1);
  const lines: string[] = [
    `# Match evaluation, live run of ${meta.date}`,
    '',
    `Taken at ${meta.takenAt}. Markets: ${meta.markets.join(', ')}.`,
    `Judge model: ${meta.models.judge ? `${meta.models.judge} (prompt ${meta.models.judgePromptVersion}; judged ${meta.models.judgedMarkets.join(', ')})` : 'none (nothing was judged)'}.`,
    `Scorer model: ${Object.entries(meta.models.scorer).map(([m, model]) => `${m} ${model ?? 'none'}`).join('; ') || 'none'}.`,
    `People: the synthetic personas of eval/fixtures. No real user's resume or profile was read.`,
    '',
    '## Labels',
    '',
    kinds.size
      ? [...kinds.entries()].map(([k, n]) => `- ${k}: ${n} value(s)`).join('\n')
      : '- No value in this report was computed from labels.',
    `- Judge audit: ${
      meta.audit
        ? `${meta.audit.pairs} pairs graded by recruiters (${Object.entries(meta.audit.markets ?? {}).map(([m, n]) => `${m} ${n}`).join(', ') || 'no market recorded'}), of judge ${meta.audit.judgeModel ?? 'unknown'}, prompt ${meta.audit.promptVersion ?? 'unknown'}; judge-human quadratic-weighted kappa ${meta.audit.kappa === null ? 'n/a' : meta.audit.kappa.toFixed(3)}`
        : 'none yet'
    }. A value computed from judge labels is untrusted until an audit of the same judge model and prompt version, with pairs of the value's market, reaches a kappa of ${JUDGE_TRUST_MIN_KAPPA} on at least ${JUDGE_TRUST_MIN_PAIRS} graded pairs.`,
    '',
    '## Samples',
    '',
    ...meta.samples.map((s) => `- ${s.what}: ${s.n}`),
    '',
    '## Gates',
    '',
    ...tableMd(report.rows),
    '',
  ];
  const noted = report.rows.filter((r) => r.note);
  if (noted.length) lines.push('## Notes', '', ...noted.map((r) => `- [${r.status}] ${r.layer} ${r.metric}: ${r.note}`), '');
  if (meta.notes.length) lines.push('## Run notes', '', ...meta.notes.map((n) => `- ${n}`), '');
  lines.push(report.failures.length ? `## Failing\n\n${report.failures.map((f) => `- ${f}`).join('\n')}\n` : 'No gate failed.\n');
  return lines.join('\n');
}

export function writeLiveReport(dir: string, meta: LiveReportMeta, report: Report): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'report.md');
  const json = path.join(dir, 'report.json');
  writeFileSync(md, renderReportMd(meta, report));
  writeFileSync(json, `${JSON.stringify({ ...meta, exitCode: report.exitCode, failures: report.failures, rows: report.rows }, null, 2)}\n`);
  return { md, json };
}
