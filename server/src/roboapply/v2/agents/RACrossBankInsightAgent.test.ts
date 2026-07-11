// backend/src/roboapply/v2/agents/RACrossBankInsightAgent.test.ts
//
// Unit tests for the Insight agent's CitationGuard: drop out-of-shortlist
// jobIds, null out raiseOddsNotes that cite no allowed lever, scrub scores.

import { describe, it, expect } from 'vitest';
import { applyCitationGuard, __test } from './RACrossBankInsightAgent.js';
import type { CrossBankInsightInput, CrossBankInsight } from '../types/crossBank.js';

const input: CrossBankInsightInput = {
  candidateHeadline: 'Senior backend engineer',
  locale: 'en',
  coverage: {
    banksSwept: ['robohire'], banksDegraded: [], totalRetrieved: 10, materialized: 8,
    recommendedCount: 2, exploreCount: 3, droppedTwins: 0, metSolidTarget: true, perBank: {},
  },
  shortlist: [
    {
      jobId: 'jobA', title: 'Backend Eng', companyName: 'Acme', bank: 'robohire',
      matchScore: 82, inviteBar: 70, barIsDefault: false, acceptanceOdds: 80, acceptanceBand: 'strong',
      tier: 'recommended', strengths: ['Go depth'], gaps: ['no Kubernetes'], raiseOddsLevers: ['kubernetes'],
    },
    {
      jobId: 'jobB', title: 'Platform Eng', companyName: 'Beta', bank: 'gohire',
      matchScore: 74, inviteBar: 60, barIsDefault: true, acceptanceOdds: 71, acceptanceBand: 'bar_unset',
      tier: 'recommended', strengths: ['distributed systems'], gaps: [], raiseOddsLevers: [],
    },
  ],
};

describe('applyCitationGuard', () => {
  it('strips perJob entries whose jobId is not in the shortlist', () => {
    const out: CrossBankInsight = {
      portfolioSummary: 'Two solid options.',
      perJob: [
        { jobId: 'jobA', acceptanceNote: 'Your Go depth fits.', raiseOddsNote: 'Add kubernetes experience.' },
        { jobId: 'GHOST', acceptanceNote: 'Fabricated.', raiseOddsNote: 'invented' },
      ],
    };
    const guarded = applyCitationGuard(out, input);
    expect(guarded.perJob.map((p) => p.jobId)).toEqual(['jobA']);
  });

  it('nulls a raiseOddsNote that cites no allowed lever', () => {
    const out: CrossBankInsight = {
      portfolioSummary: '',
      perJob: [{ jobId: 'jobA', acceptanceNote: 'Fits.', raiseOddsNote: 'Learn Rust and Scala.' }],
    };
    const guarded = applyCitationGuard(out, input);
    expect(guarded.perJob[0].raiseOddsNote).toBeNull();
  });

  it('keeps a raiseOddsNote that cites an allowed lever', () => {
    const out: CrossBankInsight = {
      portfolioSummary: '',
      perJob: [{ jobId: 'jobA', acceptanceNote: 'Fits.', raiseOddsNote: 'Pick up some kubernetes ops.' }],
    };
    const guarded = applyCitationGuard(out, input);
    expect(guarded.perJob[0].raiseOddsNote).toContain('kubernetes');
  });

  it('nulls any raiseOddsNote for a job that has no levers', () => {
    const out: CrossBankInsight = {
      portfolioSummary: '',
      perJob: [{ jobId: 'jobB', acceptanceNote: 'Strong fit.', raiseOddsNote: 'do something' }],
    };
    const guarded = applyCitationGuard(out, input);
    expect(guarded.perJob[0].raiseOddsNote).toBeNull();
  });

  it('scrubs numeric scores from prose', () => {
    expect(__test.scrubProse('You scored 82/100 here')).not.toMatch(/82\s*\/\s*100/);
    expect(__test.scrubProse('a 95% match')).not.toContain('95%');
  });
});
