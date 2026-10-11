// The job-list card renders the cited list (MKT-4H; SM-9: "the card shows
// exactly the cited jobs"). The cards here are what the server really sends:
// the list tools and `show_jobs` run over the server's area fakes, the rows
// are kept as a turn keeps them, and the card `show_jobs` returns is rendered.
// A whole list (an answer that cited nothing) keeps the plain title.
//
// Fictional data only. No network, no database, no LLM.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';

import { CopilotCardView } from './index';
import { JOB_LIST_NOTE_MAX, parseJobList } from './model';
import { CREDITS, PROFILES, card, installFetch, ok, renderUi } from '../__tests__/testkit';
import { getBrand } from '../../../../server/src/platform/brand/registry';
import { JOB_LIST_NOTE_MAX as SERVER_NOTE_MAX, type CopilotCard } from '../../../../server/src/features/copilot/contract';
import { NOW, USER, fakeAreas, feedItem, fitView } from '../../../../server/src/features/copilot/__tests__/areaFakes';
import type { CopilotAreas, CopilotTool, ListedJob, ToolContext, ToolOutput } from '../../../../server/src/features/copilot/types';
import { addedJobs, listedItems, searchJobs, showJobs, similarJobs, topFitJobs } from '../../../../server/src/features/copilot/tools/jobs';

vi.mock('../../../../server/src/services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FETCH = () =>
  installFetch({
    'GET /api/v1/roboapply/credits': () => ok(CREDITS()),
    'GET /api/v1/roboapply/search-profiles': () => ok(PROFILES()),
  });

const ATTRIBUTION = { text: '資料來源：勞動部勞動力發展署 2026「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出', url: 'https://data.gov.tw/license' };

const FEED = [
  feedItem({ jobId: 'job_a', title: 'Data Analyst', fit: { tier: 'good', score: 72, kind: 'pre', topGap: 'GraphQL', topOverlap: 'SQL', confidence: 'high', confidenceReason: null } }),
  feedItem({ jobId: 'job_b', title: 'BI Analyst', workModel: 'remote', fit: { tier: 'great', score: 88, kind: 'ai', topGap: null, topOverlap: 'SQL', confidence: 'high', confidenceReason: null } }),
  feedItem({ jobId: 'job_c', title: 'Staff Analyst', pay: null, fit: { tier: 'possible', score: 58, kind: 'pre', topGap: null, topOverlap: null, confidence: 'low', confidenceReason: 'no_skills_listed' } }),
  feedItem({ jobId: 'job_tw', title: '資料分析師', company: { id: null, name: '範例股份有限公司', logoUrl: null }, location: '台北市', cardMeta: { tw_sources: { attribution: ATTRIBUTION } } }),
  feedItem({ jobId: 'job_e', title: 'Research Analyst' }),
];
const ADDED = [
  { jobId: 'mine_1', title: 'Product Designer', companyName: 'General Intuition', location: 'New York', workModel: 'onsite' as const, applyUrl: null, sourceHost: null, addedAt: '2026-10-09T00:00:00.000Z', warnings: [], trackerStatus: null },
];

/** The server's tools over its area fakes, keeping the rows of every list as a turn does (CopilotService `listedJobs`). */
function turn(over: Partial<CopilotAreas> = {}) {
  const areas = fakeAreas({ feedPreview: async () => FEED, addedJobs: async () => ADDED, fits: async (_u, ids) => new Map(ids.map((id) => [id, { ...fitView(id), tier: 'great', score: 84, kind: 'ai' } as never])), ...over });
  const listedJobs = new Map<string, ListedJob>();
  let n = 0;
  const ctx: ToolContext = {
    userId: USER,
    brand: getBrand('roboapply'),
    market: 'intl',
    locale: 'en',
    now: NOW,
    messageId: 'msg_1',
    contextJobId: null,
    resumeId: null,
    scope: 'seeker',
    areas,
    isEnabled: async () => true,
    hiringContactsMode: () => 'on',
    propose: async () => ({ id: 'prop_1', expiresAt: new Date('2099-01-01T00:00:00.000Z') }),
    creditsLeft: async () => null,
    hasConsent: async () => false,
    newCardId: () => `card_${++n}`,
    listedJobs,
  };
  const run = async <A,>(tool: CopilotTool<A>, args: A): Promise<ToolOutput> => {
    const out = await tool.run(args, ctx);
    for (const item of listedItems(out)) listedJobs.set(item.jobId, { item, fromThisTurn: true });
    return out;
  };
  return { ctx, run, areas };
}

/** The card `show_jobs` returns for `jobIds` after a search of five rows and the user's added jobs. */
async function citedCard(jobIds: string[], note?: string): Promise<CopilotCard> {
  const t = turn();
  await t.run(searchJobs, { limit: 5 });
  await t.run(addedJobs, {});
  const out = await t.run(showJobs, { jobIds, ...(note ? { note } : {}) });
  return out.cards![0]!;
}

const rowsOf = (container: HTMLElement) => [...container.querySelectorAll('[data-card="job_list"] li')] as HTMLElement[];

describe('the cited list (show_jobs)', () => {
  it('shows exactly the jobs of the card payload, in the order given, under "Jobs mentioned in this answer", with no count of results', async () => {
    FETCH();
    const cited = await citedCard(['job_c', 'job_a']);
    const { container } = renderUi(<CopilotCardView card={cited} />);
    expect(screen.getByRole('heading', { name: 'Jobs mentioned in this answer' })).toBeInTheDocument();
    const rows = rowsOf(container);
    // Two of the five the search returned, in the order the answer cites them.
    expect(rows.map((li) => li.getAttribute('data-job'))).toEqual(['job_c', 'job_a']);
    expect(within(rows[0]!).getByRole('link', { name: 'Staff Analyst' })).toHaveAttribute('href', expect.stringContaining('job_c'));
    expect(within(rows[1]!).getByRole('link', { name: 'Data Analyst' })).toHaveAttribute('href', expect.stringContaining('job_a'));
    for (const other of ['BI Analyst', '資料分析師', 'Research Analyst', 'Product Designer']) expect(screen.queryByText(other)).toBeNull();
    // Nothing on the card implies a complete result: no "N results", "N jobs", "all N" or "of N".
    const text = container.querySelector('[data-card="job_list"]')!.textContent ?? '';
    expect(text).not.toMatch(/\b\d+\s+(?:results?|jobs?|matches|found)\b|\ball\s+\d+\b|\bof\s+\d+\b|\bshowing\b/i);
    expect(container.querySelector('[data-cited="true"]')).not.toBeNull();
    // The fit line stays with the fits.
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });

  it('the optional note is one line above the list; a card without one shows none', async () => {
    FETCH();
    const withNote = renderUi(<CopilotCardView card={await citedCard(['job_b'], 'Both list their pay.')} />);
    const note = within(withNote.container).getByTestId('job-list-note');
    expect(note).toHaveTextContent('Both list their pay.');
    // Above the list, not inside a row.
    expect(note.compareDocumentPosition(withNote.container.querySelector('ul')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.closest('li')).toBeNull();
    withNote.unmount();
    const without = renderUi(<CopilotCardView card={await citedCard(['job_b'])} />);
    expect(within(without.container).queryByTestId('job-list-note')).toBeNull();
  });

  it('the fit chip reads the feed card\'s fields: "Quick estimate" for an estimate, nothing for an AI fit, and the one plain reason when the estimate rests on little', async () => {
    FETCH();
    const { container } = renderUi(<CopilotCardView card={await citedCard(['job_a', 'job_b', 'job_c'])} />);
    const [estimate, ai, low] = rowsOf(container);
    expect(within(estimate!).getByText('Good fit')).toBeInTheDocument();
    expect(within(estimate!).getByTestId('fit-estimate-tag')).toHaveTextContent('Quick estimate');
    expect(within(estimate!).queryByTestId('job-row-estimate-reason')).toBeNull();
    expect(within(ai!).getByText('Great fit')).toBeInTheDocument();
    expect(within(ai!).queryByTestId('fit-estimate-tag')).toBeNull();
    expect(within(ai!).queryByTestId('job-row-estimate-reason')).toBeNull();
    expect(within(low!).getByTestId('fit-estimate-tag')).toHaveTextContent('Quick estimate');
    expect(within(low!).getByTestId('job-row-estimate-reason')).toHaveTextContent('This post lists no skills');
  });

  it('an import shows its label, on an added-jobs row and on a feed row that is the user\'s own import; its fit is the one batch read', async () => {
    FETCH();
    const cited = await citedCard(['mine_1', 'job_a']);
    const first = renderUi(<CopilotCardView card={cited} />);
    const [mine, publicRow] = rowsOf(first.container);
    expect(within(mine!).getByText('Added by you')).toBeInTheDocument();
    expect(within(mine!).getByText('Great fit')).toBeInTheDocument();
    // Its pay was not read here: no pay line, never "Pay not listed".
    expect(mine!).not.toHaveTextContent('Pay not listed');
    expect(within(publicRow!).queryByText('Added by you')).toBeNull();
    first.unmount();
    // The feed lists an import that has a date as a feed row: it carries the label too.
    const t = turn({ feedPreview: async () => [feedItem({ jobId: 'mine_dated', title: 'Imported Analyst', source: { name: 'Added by you', kind: 'user_import' } }), ...FEED], addedJobs: async () => [] });
    await t.run(topFitJobs, {});
    const out = await t.run(showJobs, { jobIds: ['mine_dated', 'job_a'] });
    const second = renderUi(<CopilotCardView card={out.cards![0]!} />);
    const rows = rowsOf(second.container);
    expect(within(rows[0]!).getByText('Added by you')).toBeInTheDocument();
    expect(within(rows[1]!).queryByText('Added by you')).toBeNull();
  });

  it('a 台灣就業通 open-data row prints its licence credit line, linked to the licence text; other rows print none', async () => {
    FETCH();
    const { container } = renderUi(<CopilotCardView card={await citedCard(['job_tw', 'job_a'])} />);
    const [tw, other] = rowsOf(container);
    const credit = tw!.querySelector('[data-tw-attribution]') as HTMLElement;
    expect(credit).toHaveAttribute('lang', 'zh-Hant');
    expect(credit).toHaveTextContent(ATTRIBUTION.text);
    const link = within(credit).getByRole('link', { name: ATTRIBUTION.text });
    expect(link).toHaveAttribute('href', ATTRIBUTION.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(other!.querySelector('[data-tw-attribution]')).toBeNull();
    // Still exactly one row per job (the credit line is part of its row).
    expect(rowsOf(container)).toHaveLength(2);
  });

  it('both brands render the cited card; on GoApply the title and labels come from the same keys', async () => {
    FETCH();
    const { container } = renderUi(<CopilotCardView card={await citedCard(['job_b', 'mine_1'])} />, { brand: 'goapply' });
    expect(screen.getByRole('heading', { name: 'Jobs mentioned in this answer' })).toBeInTheDocument();
    expect(rowsOf(container).map((li) => li.getAttribute('data-job'))).toEqual(['job_b', 'mine_1']);
    expect(screen.getByText('Added by you')).toBeInTheDocument();
  });
});

describe('pay a post states in words only (a similar job: `pay: null` beside `payText`)', () => {
  /** The job page's Similar jobs list as the server's `similar_jobs` tool returns it, then cited with `show_jobs`. */
  async function similarCard(): Promise<CopilotCard> {
    const t = turn({
      similarJobs: async () => ({
        by: 'similar',
        items: [
          { ...feedItem({ jobId: 'sim_words', title: 'Data Analyst II' }), pay: null, payText: 'NT$40,000 以上' },
          { ...feedItem({ jobId: 'sim_negotiable', title: 'Data Analyst III' }), pay: null, payText: '面议' },
          { ...feedItem({ jobId: 'sim_none', title: 'Data Analyst IV' }), pay: null, payText: null },
          { ...feedItem({ jobId: 'sim_figures', title: 'Data Analyst V' }), payText: null },
        ] as never,
      }),
    });
    // What the model reads for the first row is the post's words, so the card must not say there are none.
    const listed = await t.run(similarJobs, { jobId: 'job_1' });
    expect((listed.data as { jobs: Array<{ pay: unknown }> }).jobs[0]!.pay).toEqual({ text: 'NT$40,000 以上' });
    return (await t.run(showJobs, { jobIds: ['sim_words', 'sim_negotiable', 'sim_none', 'sim_figures'] })).cards![0]!;
  }
  const payOfRow = (container: HTMLElement, jobId: string) => container.querySelector(`[data-job="${jobId}"] [data-pay]`) as HTMLElement;

  it('prints the post\'s own words, never "Pay not listed" for a post that states pay; a post that states none still reads "Pay not listed"', async () => {
    FETCH();
    const { container } = renderUi(<CopilotCardView card={await similarCard()} />);
    expect(payOfRow(container, 'sim_words')).toHaveTextContent('Pay as stated: NT$40,000 以上');
    expect(payOfRow(container, 'sim_words')).toHaveAttribute('data-pay', 'words');
    expect(payOfRow(container, 'sim_words')).not.toHaveTextContent('Pay not listed');
    // Outside mainland China the words are the post's as they are (the job page's Similar jobs list prints the same).
    expect(payOfRow(container, 'sim_negotiable')).toHaveTextContent('Pay as stated: 面议');
    expect(payOfRow(container, 'sim_none')).toHaveTextContent('Pay not listed');
    expect(payOfRow(container, 'sim_none')).toHaveAttribute('data-pay', 'none');
    // Figures win over words and keep their unit.
    expect(payOfRow(container, 'sim_figures')).toHaveAttribute('data-pay', 'figures');
    expect(payOfRow(container, 'sim_figures')).not.toHaveTextContent('Pay as stated');
  });

  it('GoApply keeps its own rule: a line that only says 面议 states no pay; other words are printed', async () => {
    FETCH();
    const { container } = renderUi(<CopilotCardView card={await similarCard()} />, { brand: 'goapply' });
    expect(payOfRow(container, 'sim_negotiable')).toHaveTextContent('Pay not listed');
    expect(payOfRow(container, 'sim_negotiable')).not.toHaveTextContent('面议');
    expect(payOfRow(container, 'sim_words')).toHaveTextContent('Pay as stated: NT$40,000 以上');
  });

  it('the parser keeps the words as text only, and drops them when the row says outright that the post states no pay', () => {
    const base = { jobId: 'j1', title: 'Analyst', company: { name: 'Acme' }, pay: null };
    expect(parseJobList({ items: [{ ...base, payText: '  NT$40,000 以上  ' }] })!.items[0]).toMatchObject({ pay: null, payText: 'NT$40,000 以上', payKnown: true });
    for (const payText of [undefined, null, '', '   ', 40000, { text: 'x' }]) expect(parseJobList({ items: [{ ...base, payText }] })!.items[0]!.payText, String(payText)).toBeNull();
    expect(parseJobList({ items: [{ ...base, salary: null, payText: 'Competitive' }] })!.items[0]!.payText).toBeNull();
    // One of the user's own added jobs has no pay line at all: its pay was not read.
    expect(parseJobList({ items: [{ ...base, payKnown: false, addedByUser: true }] })!.items[0]).toMatchObject({ payText: null, payKnown: false });
  });
});

describe('the whole list (the fallback when an answer cited nothing)', () => {
  it('keeps the existing title and shows every row the tool returned, in its order', async () => {
    FETCH();
    const t = turn();
    const out = await t.run(searchJobs, { limit: 5 });
    // What CopilotService shows when the turn ends with no show_jobs call: the tool's own card.
    expect(out.list).toBe('candidates');
    const { container } = renderUi(<CopilotCardView card={out.cards![0]!} />);
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.queryByText('Jobs mentioned in this answer')).toBeNull();
    expect(rowsOf(container).map((li) => li.getAttribute('data-job'))).toEqual(['job_a', 'job_b', 'job_c', 'job_tw', 'job_e']);
    expect(container.querySelector('[data-cited]')).toBeNull();
    expect(within(container).queryByTestId('job-list-note')).toBeNull();
    // The credit line is printed here too: the row is shown, so it is credited.
    expect(container.querySelectorAll('[data-tw-attribution]')).toHaveLength(1);
  });

  it('a card stored before citing existed, and a visitor\'s list, read as whole lists', () => {
    FETCH();
    const stored = renderUi(<CopilotCardView card={card('job_list', { items: [{ jobId: 'j1', title: 'Analyst', company: { name: 'Acme' } }], query: { sort: 'best_fit' } })} />);
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    stored.unmount();
    renderUi(<CopilotCardView card={card('job_list', { items: [{ jobId: 'j1', title: 'Analyst', company: { name: 'Acme' } }], visitor: true })} />);
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
  });
});

describe('parseJobList (tolerant: a card always renders or renders nothing)', () => {
  const row = { jobId: 'j1', title: 'Analyst', company: { name: 'Acme' } };

  it('reads `cited` and the note strictly: only `true` cites, a note needs a cited list and one short line', () => {
    expect(parseJobList({ items: [row] })).toMatchObject({ cited: false, note: null });
    expect(parseJobList({ items: [row], cited: 'yes', note: 'x' })).toMatchObject({ cited: false, note: null });
    expect(parseJobList({ items: [row], note: 'A note on a whole list' })).toMatchObject({ cited: false, note: null });
    expect(parseJobList({ items: [row], cited: true, note: '  Two remote roles.  ' })).toMatchObject({ cited: true, note: 'Two remote roles.' });
    expect(parseJobList({ items: [row], cited: true, note: 'x'.repeat(JOB_LIST_NOTE_MAX + 1) })).toMatchObject({ cited: true, note: null });
    expect(parseJobList({ items: [row], cited: true, note: { text: 'x' } })).toMatchObject({ cited: true, note: null });
    expect(JOB_LIST_NOTE_MAX).toBe(SERVER_NOTE_MAX);
  });

  it('reads the fit\'s confidence with safe defaults, the import marker from either field, and the credit line only as text and a safe link', () => {
    const parsed = parseJobList({
      cited: true,
      items: [
        { ...row, fit: { tier: 'possible', score: 55, kind: 'pre', confidence: 'low', confidenceReason: 'no_level_stated' } },
        { ...row, jobId: 'j2', fit: { tier: 'good', score: 70, kind: 'pre', confidence: 'certain', confidenceReason: 7 } },
        { ...row, jobId: 'j3', fit: { tier: 'good', score: 70, kind: 'ai' }, source: { kind: 'user_import' } },
        { ...row, jobId: 'j4', addedByUser: true, cardMeta: { tw_sources: { attribution: { text: ' 資料來源 ', url: 'javascript:alert(1)' } } } },
        { ...row, jobId: 'j5', cardMeta: { tw_sources: { attribution: { text: 'x'.repeat(301), url: 'https://data.gov.tw/license' } } } },
        { ...row, jobId: 'j6', cardMeta: { tw_sources: { attribution: 'not an object' } } },
        { ...row, jobId: 'j7', source: { kind: 'ats_public' }, cardMeta: null },
      ],
    })!;
    expect(parsed.items.map((i) => [i.jobId, i.confidence, i.confidenceReason, i.addedByUser, i.attribution])).toEqual([
      ['j1', 'low', 'no_level_stated', false, null],
      ['j2', null, null, false, null],
      ['j3', null, null, true, null],
      ['j4', null, null, true, { text: '資料來源', url: null }],
      ['j5', null, null, false, null],
      ['j6', null, null, false, null],
      ['j7', null, null, false, null],
    ]);
  });

  it('a cited list of more rows than a card holds is cut to eight, in order; data that is not a list renders nothing', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...row, jobId: `j${i}` }));
    expect(parseJobList({ items: many, cited: true })!.items.map((i) => i.jobId)).toEqual(many.slice(0, 8).map((r) => r.jobId));
    expect(parseJobList({ cited: true, note: 'x' })).toBeNull();
    FETCH();
    const { container } = renderUi(<CopilotCardView card={card('job_list', { cited: true, items: [] })} />);
    expect(container.querySelector('[data-card]')).toBeNull();
  });
});
