// Inline-markdown stripping for the "what your resume says" rows.
//
// These rows are the trust device for the prefilled setup step — they are what
// earns the right to PROPOSE preferences rather than ask for them. Résumés
// arrive as markdown here (`resumeMarkdown` is a first-class column and the
// paste door produces markdown), so a real summary line looks like
// `*AI Software Engineer · alex@example.com*`, and rendering it raw shows the
// asterisks. A screen quoting someone's own résumé back at them with stray
// punctuation reads as broken parsing.
//
// The cases below are the ones worth pinning: the two that must be cleaned, and
// the several that must be LEFT ALONE, because an over-eager stripper mangles
// real résumé content (C++ , snake_case identifiers, "5 * 3").

import { describe, it, expect } from 'vitest';

import { buildIngestRows } from './raOnboardingIngestRows.js';

/** Build rows from markdown alone and return the value of one kind. */
function valueOf(markdown: string, kind: string): string | undefined {
  const rows = buildIngestRows(
    { variantName: 'CV', parsedData: null, summary: null, highlight: null, resumeMarkdown: markdown },
    'en',
  );
  return rows.find((r) => r.kind === kind)?.value;
}

describe('ingest rows — inline markdown', () => {
  it('unwraps the emphasis a real résumé header carries', () => {
    const v = valueOf(
      '# Alex Chen\n\n*AI Software Engineer · alex@example.com · github.com/alexchen*\n',
      'identity',
    );
    expect(v).toBe('Alex Chen');
  });

  it('unwraps bold and links in a summary line', () => {
    const rows = buildIngestRows(
      {
        variantName: 'CV',
        parsedData: null,
        summary: '**Staff Engineer** at [Stripe](https://stripe.com), payments infrastructure',
        highlight: null,
        resumeMarkdown: null,
      },
      'en',
    );
    const summary = rows.find((r) => r.kind === 'summary')?.value;
    expect(summary).toBe('Staff Engineer at Stripe, payments infrastructure');
  });

  it('leaves real résumé content that merely looks like markdown', () => {
    const rows = buildIngestRows(
      {
        variantName: 'CV',
        parsedData: null,
        // Every one of these appears in real résumés and must survive intact.
        summary: 'Scaled throughput 5 * 3x using snake_case_configs and C++ tooling',
        highlight: null,
        resumeMarkdown: null,
      },
      'en',
    );
    const summary = rows.find((r) => r.kind === 'summary')?.value;
    expect(summary).toBe('Scaled throughput 5 * 3x using snake_case_configs and C++ tooling');
  });

  it('strips a leading bullet without eating the text', () => {
    const rows = buildIngestRows(
      {
        variantName: 'CV',
        parsedData: null,
        summary: '- Led a team of six',
        highlight: null,
        resumeMarkdown: null,
      },
      'en',
    );
    expect(rows.find((r) => r.kind === 'summary')?.value).toBe('Led a team of six');
  });
});
