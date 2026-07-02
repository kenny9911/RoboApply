// Mock Interview AI helpers — pure functions only (no UI, no network).
//
// Pins: filler-word detection, STAR detection, scoring shape, JD-based custom
// mock generation, follow-up probe trigger.

import { describe, it, expect } from 'vitest';
import {
  buildGreeting,
  buildQuestionTurn,
  countFillerWords,
  detectStar,
  generateReport,
  makeMockFromJd,
  makeMockFromTopic,
  maybeFollowUp,
} from '../../lib/mockInterview/ai';
import { FIXTURE_MOCKS } from '../../lib/mockInterview/fixtures';
import type { MockSession } from '../../lib/mockInterview/types';

const mock = FIXTURE_MOCKS[0]; // Redis Deep Dive
const q = mock.questions[0];

describe('Mock Interview — filler word detection', () => {
  it('counts common fillers', () => {
    const t = 'Um, so basically I, you know, kind of did the thing';
    expect(countFillerWords(t)).toBeGreaterThanOrEqual(4);
  });
  it('ignores absence of fillers', () => {
    expect(countFillerWords('I led the project and shipped it.')).toBe(0);
  });
});

describe('Mock Interview — STAR detection', () => {
  it('detects all four STAR signals in a strong answer', () => {
    const t = 'When I was at Stripe, my goal was to cut latency. I led a migration to streaming and shipped it; we reduced p99 by 38%.';
    const star = detectStar(t);
    expect(star.situation).toBe(true);
    expect(star.task).toBe(true);
    expect(star.action).toBe(true);
    expect(star.result).toBe(true);
  });
  it('flags missing pieces', () => {
    const star = detectStar('I did some Redis work.');
    expect(star.result).toBe(false);
  });
});

describe('Mock Interview — follow-up probing', () => {
  it('probes a thin answer', () => {
    const f = maybeFollowUp(q, 'I have used Redis.', 'curious');
    expect(f).not.toBeNull();
    expect(f?.followUp).toBe(true);
  });
  it('lets a strong answer through without probing', () => {
    const ans = 'In production I have used Strings for caches, Hashes for record-like objects, Sorted Sets for leaderboards (O(log N) range), Streams when Kafka was overkill, and HyperLogLog for unique counts. Strings bit me with key fan-out; Streams bit me with consumer-group rebalancing.';
    const f = maybeFollowUp(q, ans, 'curious');
    expect(f).toBeNull();
  });
});

describe('Mock Interview — report generation', () => {
  it('produces a score, dimensions, and per-question rows', () => {
    const greeting = buildGreeting('curious');
    const first = buildQuestionTurn(q, 'curious', true);
    const session: MockSession = {
      id: 'sess_test',
      mockId: mock.id,
      startedAt: '2026-05-28T00:00:00.000Z',
      endedAt: '2026-05-28T00:15:00.000Z',
      style: 'curious',
      turns: [
        greeting,
        first,
        {
          id: 't1', role: 'candidate', at: '2026-05-28T00:01:00.000Z',
          questionId: q.id,
          text: 'I have used Strings, Hashes, Sorted Sets, Streams, and HyperLogLog in production. Strings for cache, Hashes for objects, Sorted Sets for leaderboards with O(log N) range, Streams when Kafka was overkill. Reduced p99 by 30%.',
        },
        ...mock.questions.slice(1).map((q2, i) => ({
          id: `t${i + 2}`, role: 'interviewer' as const, at: '2026-05-28T00:02:00.000Z',
          questionId: q2.id,
          text: q2.prompt,
        })),
        ...mock.questions.slice(1).map((q2, i) => ({
          id: `tc${i + 2}`, role: 'candidate' as const, at: '2026-05-28T00:03:00.000Z',
          questionId: q2.id,
          text: 'Brief',
        })),
      ],
      reportId: null,
    };
    const report = generateReport(mock, session);
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.dimensions.communication).toBeGreaterThanOrEqual(0);
    expect(report.dimensions.structure).toBeGreaterThanOrEqual(0);
    expect(report.perQuestion).toHaveLength(mock.questions.length);
    expect(report.perQuestion[0].score).toBeGreaterThan(report.perQuestion[1].score);
  });
});

describe('Mock Interview — JD/Topic custom mocks', () => {
  it('extracts skills from JD and templates 6 questions', () => {
    const jd = 'We are looking for a Senior Software Engineer who has experience with Postgres, distributed systems, observability, and Kafka. You will own the data ingestion pipeline.';
    const m = makeMockFromJd(jd, 'Senior Software Engineer');
    expect(m.isCustom).toBe(true);
    expect(m.questions).toHaveLength(6);
    expect(m.skills.length).toBeGreaterThan(0);
    expect(m.customSource?.kind).toBe('jd');
  });
  it('topic mock includes the topic in every question prompt', () => {
    const m = makeMockFromTopic('Kafka');
    expect(m.title).toMatch(/Kafka/);
    expect(m.questions.every((q) => /Kafka/.test(q.prompt))).toBe(true);
  });
});
