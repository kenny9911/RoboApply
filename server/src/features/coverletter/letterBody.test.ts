// @vitest-environment node
//
// WP-37 letter body: assembly, per-sentence citations that survive edits,
// version history (≤20, coalesced autosave edits) and the signature.

import { describe, expect, it } from 'vitest';
import {
  EDIT_COALESCE_MS,
  assembleBody,
  citationsForBody,
  draftSentences,
  pushVersion,
  remapCitations,
  sentenceViews,
  signatureFromResume,
  versionViews,
  type LetterDraft,
} from './letterBody.js';
import { MAX_LETTER_VERSIONS, type LetterVersion } from './contract.js';
import { CLEAN_LETTER, RESUME_MD } from './fixtures.js';

const draft: LetterDraft = {
  greeting: CLEAN_LETTER.greeting,
  closing: CLEAN_LETTER.closing,
  paragraphs: CLEAN_LETTER.paragraphs.map((p) => p.map((s) => ({ text: s.text, kind: s.kind, cites: s.cites as LetterDraft['paragraphs'][0][0]['cites'] }))),
};

describe('assembleBody / citations', () => {
  const body = assembleBody(draft, 'en', 'Sam Lee');

  it('puts greeting, paragraphs and the sign-off with the name', () => {
    expect(body.split('\n\n')).toHaveLength(4);
    expect(body.startsWith('Dear Hiring Manager,\n\n')).toBe(true);
    expect(body.endsWith('Sincerely,\nSam Lee')).toBe(true);
  });

  it('joins CJK sentences without spaces', () => {
    const zh = assembleBody({ greeting: '尊敬的招聘负责人：', closing: '此致', paragraphs: [[{ text: '我负责过支付系统。', cites: [] }, { text: '我会学习。', cites: [] }]] }, 'zh');
    expect(zh).toBe('尊敬的招聘负责人：\n\n我负责过支付系统。我会学习。\n\n此致');
  });

  it('cites every body sentence and never the greeting or sign-off', () => {
    const cits = citationsForBody(body, draftSentences(draft));
    const views = sentenceViews(body, cits);
    expect(views.map((v) => v.index)).toEqual([1, 2, 3, 4]);
    expect(views.every((v) => v.sources.length > 0)).toBe(true);
    expect(views[1]!.sources[0]).toEqual({ source: 'resume', ref: expect.stringContaining('Led migration of 7 Postgres') });
  });

  it('an edit keeps unchanged sentences’ citations and marks new ones as the user’s', () => {
    const cits = citationsForBody(body, draftSentences(draft));
    const edited = body.replace('I also built the refunds API in Go serving 40 merchants.', 'I enjoy hard problems.').replace('Sincerely,', 'Best,');
    const next = remapCitations(body, cits, edited);
    const views = sentenceViews(edited, next);
    expect(views.find((v) => v.text === 'I enjoy hard problems.')!.sources).toEqual([{ source: 'user', ref: '' }]);
    expect(views.find((v) => v.text.startsWith('At Acme Pay'))!.sources[0]!.source).toBe('resume');
    // A changed sign-off is the user's words too; the untouched greeting stays uncited.
    expect(views.find((v) => v.text === 'Best,')!.sources).toEqual([{ source: 'user', ref: '' }]);
    expect(views.some((v) => v.text === 'Dear Hiring Manager,')).toBe(false);
  });
});

describe('versions', () => {
  const v = (reason: string, at: Date, body = reason): LetterVersion => ({ body, reason, createdAt: at.toISOString() });
  const t0 = new Date('2026-10-10T10:00:00Z');

  it('coalesces autosaved edits inside the window, then starts a new one', () => {
    let list = [v('generated', t0)];
    list = pushVersion(list, v('edit', t0, 'a'), t0);
    const t1 = new Date(t0.getTime() + 60_000);
    list = pushVersion(list, v('edit', t1, 'ab'), t1);
    expect(list.map((x) => x.body)).toEqual(['generated', 'ab']);
    const t2 = new Date(t1.getTime() + EDIT_COALESCE_MS + 1);
    list = pushVersion(list, v('edit', t2, 'abc'), t2);
    expect(list.map((x) => x.body)).toEqual(['generated', 'ab', 'abc']);
  });

  it('keeps at most 20, dropping the oldest', () => {
    let list: LetterVersion[] = [];
    for (let i = 0; i < 25; i += 1) list = pushVersion(list, v('rewrite', t0, `b${i}`), t0);
    expect(list).toHaveLength(MAX_LETTER_VERSIONS);
    expect(list[0]!.body).toBe('b5');
  });

  it('marks the version the body shows', () => {
    const views = versionViews([v('generated', t0, 'x'), v('rewrite', t0, 'y')], 'x');
    expect(views.map((x) => [x.index, x.reason, x.current])).toEqual([
      [0, 'generated', true],
      [1, 'rewrite', false],
    ]);
  });
});

describe('signatureFromResume', () => {
  it('reads the # Name line', () => {
    expect(signatureFromResume(RESUME_MD)).toBe('Sam Lee');
    expect(signatureFromResume('## Experience\n- x')).toBeNull();
  });
});
