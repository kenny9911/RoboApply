// The job sources view (PAR-7): each brand's admin sees its own sources from
// the job source registry — the GoHire bank over its web connection with real
// counters and the reason its jobs are not shown, the company job boards with
// what the last check counted — and a GoApply admin can add a public board.
// RoboApply keeps its own company-boards panel; the shared sources panel is
// added below it. API wrappers are mocked; nothing reaches the network.

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../__tests__/utils/mockAuth';

vi.mock('../../../../lib/auth/AuthProvider', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useAuth: () => mockAuthState.value }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/sources', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const api = vi.hoisted(() => ({ getSystemStatus: vi.fn() }));
vi.mock('../../../../lib/api/admin', async (orig) => {
  const real = await orig<typeof import('../../../../lib/api/admin')>();
  return { ...real, adminConsoleApi: { ...real.adminConsoleApi, ...api } };
});
const boards = vi.hoisted(() => ({
  adminListCareerSources: vi.fn(),
  adminCreateCareerSource: vi.fn(),
  adminUpdateCareerSource: vi.fn(),
  adminDeleteCareerSource: vi.fn(),
  adminRunCareerSource: vi.fn(),
}));
vi.mock('../../../../lib/api/careerSources', () => boards);

import { CareerBoardsPanel, JobSourcesPanel, SourcesConsole, TALLY_ORDER, boardProblemKey } from '../SourcesConsole';
import type { BrandHealth, JobSourceRunView, JobSourceView, SystemStatusResponse } from '../../../../lib/api/admin';
import type { CareerSourceView } from '../../../../lib/api/careerSources';
import { RoboApiError } from '../../../../lib/api/client';
import en from '../../../../i18n/staging/admin.en.json';
import zh from '../../../../i18n/staging/admin.zh.json';

const admin = () => buildAuthValue({ user: { ...buildFakeUser(), role: 'admin' } as never });

const run = (over: Partial<JobSourceRunView> = {}): JobSourceRunView => ({ at: '2026-10-11T07:50:00.000Z', ok: true, error: null, received: 0, written: 0, inserted: 0, closed: 0, skipped: 0, notes: {}, ...over });
const source = (over: Partial<JobSourceView>): JobSourceView => ({
  provider: 'ats_public', kind: 'ats', enabled: true, transport: 'board_api', reason: null, lastRun: null, lastCounted: null, openJobs: 0, heldJobs: 0, publicPage: null, boards: null, ...over,
});

const GOHIRE = source({
  provider: 'bank_gohire', kind: 'bank', transport: 'api',
  lastRun: run({ at: '2026-10-11T07:55:00.000Z' }),
  lastCounted: run({ notes: { bank_synced: 181, bank_no_public_page: 181, bank_unpublished: 1092, bank_no_company: 3, bank_test_posting: 2 } }),
  publicPage: { configured: false, variable: 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE' },
});
const BOARDS = source({
  lastRun: run({ received: 412, written: 398, inserted: 398, skipped: 14, notes: { boards_read: 26, wrong_market: 9, no_apply_url: 5 } }),
  openJobs: 398,
  boards: { total: 26, enabled: 26, failing: 1 },
});
const IMPORT = source({ provider: 'user_import', kind: 'import', transport: 'off' });

const health = (over: Partial<BrandHealth> = {}): BrandHealth => ({
  brand: 'goapply', market: 'cn', sources: [GOHIRE, BOARDS, IMPORT],
  ingest: { due: 0, overdue: 0, failing: 0, newJobsToday: 0, newJobs7dAvg: 0, openJobs: 398, enrichBacklog: 0, enrichedShare: 1, enrichBudget: { used: 0, limit: 8000 } },
  precompute: { used: 0, limit: 20000 }, alerts: { sent: 0, failed: 0 }, email: { sent: 0, failed: 0, failedByTemplate: [] },
  copilot: { turns: 0, guardHits: 0, costUsd: 0, budgetUsd: 50 }, creditExhaustion: null, ...over,
});
const statusOf = (b: BrandHealth): SystemStatusResponse => ({ asOf: '2026-10-11T08:00:00.000Z', dayKey: '2026-10-11', dayComplete: false, dayElapsedShare: 0.3, brands: [b], queue: { kinds: [], deadTotal: 0 }, providers: [], alerts: [], brandsServed: ['roboapply', 'goapply'] });

const board = (over: Partial<CareerSourceView> = {}): CareerSourceView => ({
  id: 'cs1', market: 'cn', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', companyId: null, countryCode: 'CN', enabled: true,
  lastSyncedAt: '2026-10-11T07:00:00.000Z', lastJobCount: 1317, lastError: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.value = admin();
  api.getSystemStatus.mockResolvedValue(statusOf(health()));
  boards.adminListCareerSources.mockResolvedValue({ items: [board()], cursor: null });
});

describe('JobSourcesPanel', () => {
  it('GoApply: the GoHire bank over its web connection, the reason most open requisitions are skipped, and why its synced jobs are not shown', () => {
    renderWithBrand(<JobSourcesPanel health={health()} />, { brand: 'goapply' });
    const bank = screen.getByRole('listitem', { name: 'GoHire recruiter jobs' });
    expect(within(bank).getByText('On')).toBeInTheDocument();
    expect(within(bank).getByText('Read over a secure web connection')).toBeInTheDocument();
    expect(within(bank).getByText('Open but not published by the recruiter: 1,092')).toBeInTheDocument();
    expect(within(bank).getByText('Published jobs with a named employer: 181')).toBeInTheDocument();
    expect(within(bank).getByText('No employer named: 3')).toBeInTheDocument();
    expect(within(bank).getByText('Test postings: 2')).toBeInTheDocument();
    // No public job page template: saved, not shown, and the setting is named.
    const note = within(bank).getByRole('note');
    expect(within(note).getByText('These jobs are saved but not shown')).toBeInTheDocument();
    expect(note).toHaveTextContent('GoHire has no public page for a single job yet');
    expect(note).toHaveTextContent('GOHIRE_PUBLIC_JOB_URL_TEMPLATE');
    expect(note).toHaveTextContent('181 published jobs are waiting');
    expect(within(bank).getByText('No public job page to link to: 181')).toBeInTheDocument();
  });

  it('the company job boards show real counters, and "outside mainland China" on GoApply', () => {
    renderWithBrand(<JobSourcesPanel health={health()} />, { brand: 'goapply' });
    const card = screen.getByRole('listitem', { name: 'Company job boards' });
    expect(within(card).getByText("Read from each board's public job feed")).toBeInTheDocument();
    expect(within(card).getByText('26 of 26 on')).toBeInTheDocument();
    expect(within(card).getByText('1 board could not be read last time')).toBeInTheDocument();
    expect(within(card).getByText('Boards checked: 26')).toBeInTheDocument();
    expect(within(card).getByText('Located outside mainland China: 9')).toBeInTheDocument();
    expect(within(card).getByText('No link to apply: 5')).toBeInTheDocument();
    // Jobs people can see now / saved in the last check: both 398.
    expect(within(card).getAllByText('398')).toHaveLength(2);
    // A person's own imports are a source too, with no counters to show.
    const mine = screen.getByRole('listitem', { name: 'Jobs people add themselves' });
    expect(within(mine).queryByText('On')).not.toBeInTheDocument();
  });

  it('with the page set the bank says so; an off source says why; a failed check shows its error; a tally code with no sentence is never printed', () => {
    const sources = [
      source({ provider: 'bank_gohire', kind: 'bank', transport: 'api', publicPage: { configured: true, variable: 'GOHIRE_PUBLIC_JOB_URL_TEMPLATE' }, lastRun: run({ written: 181 }), openJobs: 181 }),
      source({ provider: 'bank_robohire', kind: 'bank', enabled: false, transport: 'off', reason: 'tls_required', publicPage: { configured: false, variable: 'ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE' } }),
      source({ provider: 'jsearch', kind: 'search', transport: 'rapidapi', lastRun: run({ ok: false, error: 'provider_unavailable' }) }),
      source({
        provider: 'activejobs', kind: 'search', enabled: false, transport: 'off', reason: 'brand_new_code',
        // Informational normalizer notes and an unknown counter, next to real skip reasons.
        lastRun: run({ notes: { new_counter: 4, salary_currency_from_search_country: 9, linkedin_logo_dropped: 3, applicant_count_dropped: 2, wrong_market: 2, missing_title_or_company: 6, private_row: 1, normalize_failed: 7, no_external_id: 8 } }),
      }),
    ];
    renderWithBrand(<JobSourcesPanel health={health({ brand: 'roboapply', market: 'intl', sources })} showBrand />);
    expect(screen.getByRole('heading', { name: 'Where the jobs come from: roboapply' })).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'GoHire recruiter jobs' })).getByText('Its public job page is set. Each job links to that page.')).toBeInTheDocument();
    const robohire = screen.getByRole('listitem', { name: 'RoboHire recruiter jobs' });
    expect(within(robohire).getByText('Its database connection is not encrypted, so we do not open it.')).toBeInTheDocument();
    expect(within(robohire).getByRole('note')).toHaveTextContent('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE');
    expect(within(robohire).getByText('Not checked yet')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'JSearch' })).getByRole('status')).toHaveTextContent('The last check failed: provider_unavailable');
    const active = screen.getByRole('listitem', { name: 'Active Jobs DB' });
    expect(within(active).getByText('Off (brand_new_code).')).toBeInTheDocument();
    expect(within(active).getByText('Located in mainland China, so not for this site: 2')).toBeInTheDocument();
    // Review fix: every reason the server keeps has a plain sentence …
    expect(within(active).getByText('No job title or employer name: 6')).toBeInTheDocument();
    expect(within(active).getByText('Already saved privately by a user, left as it is: 1')).toBeInTheDocument();
    expect(within(active).getByText('Could not be read: 7')).toBeInTheDocument();
    expect(within(active).getByText('No posting ID from the source: 8')).toBeInTheDocument();
    // … and nothing else is printed: no snake_case code reaches the page.
    expect(active.textContent).not.toMatch(/new_counter|salary_currency|linkedin_logo|applicant_count|[a-z]+_[a-z]+_[a-z]+: \d/);
    for (const key of TALLY_ORDER) expect(Object.keys(en.admin.console.sources.skips), key).toContain(key === 'wrong_market' ? 'wrong_market_cn' : key);
    expect(Object.keys(en.admin.console.sources.skips)).not.toContain('other');
  });

  it('a site with no source says so, and nothing is invented', () => {
    renderWithBrand(<JobSourcesPanel health={health({ sources: [] })} />, { brand: 'goapply' });
    expect(screen.getByText('This site has no job source yet.')).toBeInTheDocument();
  });
});

describe('SourcesConsole (/admin/sources)', () => {
  it('GoApply: the sources of GoApply and its company job boards; the System status is asked for this brand only', async () => {
    renderWithBrand(<SourcesConsole intlBoards={<p>RoboApply boards panel</p>} />, { brand: 'goapply' });
    expect(await screen.findByRole('listitem', { name: 'GoHire recruiter jobs' })).toBeInTheDocument();
    expect(api.getSystemStatus).toHaveBeenCalledWith({ brand: 'goapply' });
    expect(screen.getByRole('heading', { level: 1, name: 'Job sources' })).toBeInTheDocument();
    expect(screen.queryByText('RoboApply boards panel')).not.toBeInTheDocument();
    expect(await screen.findByRole('rowheader', { name: 'Bosch Group' })).toBeInTheDocument();
    expect(boards.adminListCareerSources).toHaveBeenCalledWith({ market: 'cn' });
    expect(screen.getByText('1,317')).toBeInTheDocument();
  });

  it('RoboApply: its own boards panel is kept as it is, followed by the shared sources panel', async () => {
    api.getSystemStatus.mockResolvedValue(statusOf(health({ brand: 'roboapply', market: 'intl', sources: [source({ provider: 'jsearch', kind: 'search', transport: 'rapidapi' }), BOARDS] })));
    renderWithBrand(<SourcesConsole intlBoards={<p>RoboApply boards panel</p>} />, { brand: 'roboapply' });
    expect(screen.getByText('RoboApply boards panel')).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'JSearch' })).toBeInTheDocument();
    expect(api.getSystemStatus).toHaveBeenCalledWith({ brand: 'roboapply' });
    // GoApply's board manager is not rendered on RoboApply: its panel stays the only one.
    expect(boards.adminListCareerSources).not.toHaveBeenCalled();
    expect(screen.queryByRole('listitem', { name: 'GoHire recruiter jobs' })).not.toBeInTheDocument();
  });

  it('is for admins only', () => {
    mockAuthState.value = buildAuthValue({ user: { ...buildFakeUser(), role: 'user' } as never });
    renderWithBrand(<SourcesConsole />, { brand: 'goapply' });
    expect(screen.queryByRole('heading', { level: 1, name: 'Job sources' })).not.toBeInTheDocument();
    expect(api.getSystemStatus).not.toHaveBeenCalled();
  });

  it('RoboApply, not an admin: only its own panel answers (one not-authorized block, never two); the shared panel is not rendered or loaded', () => {
    mockAuthState.value = buildAuthValue({ user: { ...buildFakeUser(), role: 'user' } as never });
    renderWithBrand(<SourcesConsole intlBoards={<p>the panel's own block</p>} />, { brand: 'roboapply' });
    expect(screen.getByText("the panel's own block")).toBeInTheDocument();
    // The console's own gate ("This console is for administrators only.") is not added below it.
    expect(screen.queryByText('This console is for administrators only.')).not.toBeInTheDocument();
    expect(api.getSystemStatus).not.toHaveBeenCalled();
  });

  it('RoboApply, while the sign-in state loads: one loading line (the panel\'s own), not two', () => {
    mockAuthState.value = buildAuthValue({ status: 'loading', user: null } as never);
    const { container } = renderWithBrand(<SourcesConsole intlBoards={<p aria-busy="true">panel loading</p>} />, { brand: 'roboapply' });
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    expect(api.getSystemStatus).not.toHaveBeenCalled();
  });

  it('a failed load offers a retry', async () => {
    api.getSystemStatus.mockRejectedValueOnce(new Error('down'));
    renderWithBrand(<SourcesConsole />, { brand: 'goapply' });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem', { name: 'GoHire recruiter jobs' })).toBeInTheDocument();
  });
});

describe('CareerBoardsPanel (GoApply can add a public board)', () => {
  it('adds a board for mainland China and reloads the list', async () => {
    boards.adminCreateCareerSource.mockResolvedValue(board({ id: 'cs2', ats: 'greenhouse', boardToken: 'riotgames', companyName: 'Riot Games' }));
    renderWithBrand(<CareerBoardsPanel market="cn" />, { brand: 'goapply' });
    await screen.findByRole('rowheader', { name: 'Bosch Group' });
    const add = screen.getByRole('button', { name: 'Add board' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Board ID/), { target: { value: ' riotgames ' } });
    fireEvent.change(screen.getByLabelText(/Company name/), { target: { value: 'Riot Games' } });
    fireEvent.click(add);
    await waitFor(() => expect(boards.adminCreateCareerSource).toHaveBeenCalledWith({ market: 'cn', ats: 'greenhouse', boardToken: 'riotgames', companyName: 'Riot Games', countryCode: 'CN' }));
    await waitFor(() => expect(boards.adminListCareerSources).toHaveBeenCalledTimes(2));
  });

  it('says so when the board is already in the list', async () => {
    boards.adminCreateCareerSource.mockRejectedValue(Object.assign(new Error('conflict'), { code: 'conflict' }));
    renderWithBrand(<CareerBoardsPanel market="cn" />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText(/Board ID/), { target: { value: 'BoschGroup' } });
    fireEvent.change(screen.getByLabelText(/Company name/), { target: { value: 'Bosch Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already in the list|did not work/);
  });

  it('says when the other site already reads the board, and when the board is in this list', async () => {
    const conflict = (details: Record<string, unknown>) => new RoboApiError('conflict', { code: 'conflict', status: 409, payload: { code: 'conflict', details } });
    boards.adminCreateCareerSource.mockRejectedValueOnce(conflict({ field: 'boardToken', reason: 'board_on_other_site' }));
    renderWithBrand(<CareerBoardsPanel market="cn" />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText(/Board ID/), { target: { value: 'airbnb' } });
    fireEvent.change(screen.getByLabelText(/Company name/), { target: { value: 'Airbnb' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This board is already read for the other site, so it cannot be added here. A board is read for one site at a time.');
    boards.adminCreateCareerSource.mockRejectedValueOnce(conflict({ field: 'boardToken' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add board' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This board is already in the list.'));
  });

  it('"Check now" reports what the board lists for this site; turning off and removing ask the server', async () => {
    boards.adminRunCareerSource.mockResolvedValue({ sourceId: 'cs1', status: 'scheduled', listed: 1317, queued: true, error: null });
    boards.adminUpdateCareerSource.mockResolvedValue(board({ enabled: false }));
    boards.adminDeleteCareerSource.mockResolvedValue({ archivedJobs: 3 });
    renderWithBrand(<CareerBoardsPanel market="cn" />, { brand: 'goapply' });
    fireEvent.click(await screen.findByRole('button', { name: 'Check Bosch Group now' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Bosch Group: the board lists 1,317 postings for this site. Reading them has started.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn Bosch Group on or off' }));
    await waitFor(() => expect(boards.adminUpdateCareerSource).toHaveBeenCalledWith('cs1', { enabled: false }));
    // Removing asks first.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bosch Group' }));
    expect(boards.adminDeleteCareerSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove and hide its jobs' }));
    await waitFor(() => expect(boards.adminDeleteCareerSource).toHaveBeenCalledWith('cs1'));
  });

  it('while the list loads it says "Loading…", never "Not checked yet"', async () => {
    let finish: (value: unknown) => void = () => undefined;
    boards.adminListCareerSources.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderWithBrand(<CareerBoardsPanel market="cn" />, { brand: 'goapply' });
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Not checked yet')).not.toBeInTheDocument();
    finish({ items: [], cursor: null });
    expect(await screen.findByText('No board yet. Add one above.')).toBeInTheDocument();
  });

  it('a board that could not be read shows the problem in plain words; an empty list says what to do', async () => {
    boards.adminListCareerSources.mockResolvedValue({ items: [board({ lastError: 'http_503', lastJobCount: null, lastSyncedAt: null })], cursor: null });
    const first = renderWithBrand(<CareerBoardsPanel market="cn" />, { brand: 'goapply' });
    expect(await screen.findByText('The job board system had a problem. It will be tried again later.')).toBeInTheDocument();
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    first.unmount();
    boards.adminListCareerSources.mockResolvedValue({ items: [], cursor: null });
    renderWithBrand(<CareerBoardsPanel market="cn" />, { brand: 'goapply' });
    expect(await screen.findByText('No board yet. Add one above.')).toBeInTheDocument();
    expect(boardProblemKey('http_429')).toBe('rate_limited');
    expect(boardProblemKey('network:ECONNRESET')).toBe('network');
    expect(boardProblemKey('whatever')).toBe('other');
  });
});

describe('staged copy', () => {
  const keys = (o: Record<string, unknown>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
  it('every English key has its Chinese twin, with the same placeholders, and no brand name or long dash is typed', () => {
    expect(keys(zh).sort()).toEqual(keys(en).sort());
    const flat = (o: Record<string, unknown>, p = ''): Array<[string, string]> => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]]));
    const zhText = new Map(flat(zh));
    const vars = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    for (const [key, text] of flat(en)) {
      expect(vars(zhText.get(key) ?? ''), key).toEqual(vars(text));
      expect(text, key).not.toMatch(/RoboApply|GoApply|—/);
      expect(zhText.get(key), key).not.toMatch(/RoboApply|GoApply|——/);
    }
  });
});
