// components/features/today/today.testkit.tsx — test helpers for /today.
// Not imported by app code. Fixtures are fictional.
//
// `sourcesWith()` builds the reads TodayDesk is handed (hooks/today
// `TodaySources`) with every read answered and nothing waiting, so a test
// states only what it is about.

import type { ReactElement } from 'react';
import type { AbstractIntlMessages } from 'next-intl';

import { capsFor } from '../../../__tests__/shell/helpers';
import { defaultMessages } from '../../../__tests__/utils/mockTranslations';
import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import { BrandProvider } from '../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../lib/brand/client';
import type { BrandId } from '../../../lib/brand/registry.generated';
import type { ResolvedFlags } from '../../../lib/flags';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import type { TrackerEntryView } from '../../../lib/api/contracts/tracker';
import type { ResumeSummary } from '../../../lib/api/resumes';
import type { ReadyQueueItem } from '../../../hooks/agent';
import type { SearchProfile } from '../../../hooks/search';
import type { Loadable, TodaySources } from '../../../hooks/today';
import type { PipelineBoardData } from '../../../hooks/usePipelineBoard';

/** English as shipped: the `today` strings live in the merged bundle (i18n/messages/en.json). */
export const TODAY_MESSAGES = defaultMessages as AbstractIntlMessages;

/** Wednesday 11 November 2026, midday in the machine's own zone (the same calendar day everywhere). */
export const NOW = new Date(2026, 10, 11, 12, 0, 0);

const DAY = 24 * 60 * 60 * 1000;
export const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

export function renderToday(ui: ReactElement, { flags = {}, brand = 'roboapply' }: { flags?: Partial<ResolvedFlags>; brand?: BrandId } = {}) {
  const caps = capsFor(brand, flags);
  const withBrand = (node: ReactElement) => (
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={caps}>
      {node}
    </BrandProvider>
  );
  const view = renderWithProviders(withBrand(ui), { intlMessages: TODAY_MESSAGES });
  // `rerender` keeps the same providers around the new element, so the page keeps its state (as a data refresh does).
  return { ...view, rerender: (next: ReactElement) => view.rerender(withBrand(next)) };
}

export const ready = <T,>(data: T): Loadable<T> => ({ status: 'ready', data });
export const loading: Loadable<never> = { status: 'loading' };
export const off: Loadable<never> = { status: 'off' };
export const failed = (retry: () => void = () => undefined): Loadable<never> => ({ status: 'error', retry });

export function kit(over: Partial<ReadyQueueItem> = {}): ReadyQueueItem {
  return {
    id: 'q1',
    jobId: 'job1',
    state: 'ready_for_review',
    weekKey: '2026-W46',
    trackerEntryId: null,
    resumeVariantId: null,
    coverLetterId: null,
    missingFields: [],
    addedVia: 'suggestions',
    openedAt: null,
    userMarkedSubmitted: false,
    updatedAt: daysAgo(1),
    job: { title: 'Data Analyst', companyName: 'Acme', location: 'Austin, TX', hasApplyUrl: true, closed: false, asksForCoverLetter: false },
    ...over,
  };
}

export function resume(over: Partial<ResumeSummary> = {}): ResumeSummary {
  return {
    id: 'rv_base',
    name: 'Avery Chen — Product',
    kind: 'base',
    targetJobId: null,
    targetJobTitle: null,
    targetJobCompany: null,
    matchScoreCached: null,
    isPrimary: true,
    sourceKind: 'upload',
    lastEditedAt: daysAgo(5),
    createdAt: daysAgo(30),
    ...over,
  };
}

export function entry(over: Partial<TrackerEntryView> = {}): TrackerEntryView {
  return {
    id: 'trk1',
    userId: 'u1',
    jobId: 'job1',
    status: 'applied',
    excitementStars: 0,
    maxSalary: null,
    maxSalaryCurrency: null,
    notesMarkdown: null,
    dateSaved: daysAgo(20),
    dateApplied: daysAgo(1),
    deadline: null,
    followUpAt: null,
    appliedVia: null,
    linkedRunId: null,
    job: null,
    externalSnapshot: null,
    createdAt: daysAgo(20),
    updatedAt: daysAgo(1),
    source: null,
    stageDetail: null,
    outcome: null,
    interviewAt: null,
    offer: null,
    tailoredVariantId: null,
    coverLetterId: null,
    ...over,
  };
}

export function board(entries: TrackerEntryView[] = [], statusCounts?: Record<string, number>): PipelineBoardData {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return { entries, statusCounts: statusCounts ?? counts, total: entries.length };
}

export function pick(jobId: string, title: string, over: Partial<FeedItem> = {}): FeedItem {
  return {
    jobId,
    title,
    company: { id: null, name: 'Globex', logoUrl: null },
    location: 'Austin, TX',
    workModel: 'hybrid',
    employmentType: null,
    seniority: null,
    pay: null,
    postedAt: null,
    lastSeenAt: null,
    source: { name: 'Example Board', kind: 'provider' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    fit: { tier: 'good', score: 74, kind: 'ai', topGap: 'They ask for SQL window functions.', topOverlap: 'Three years of dashboards.' },
    tracker: null,
    ...over,
  };
}

export function searchProfile(over: Partial<SearchProfile> = {}): SearchProfile {
  return {
    id: 'sp_main',
    name: '',
    isDefault: true,
    isActive: true,
    version: 3,
    schemaVersion: 1,
    filters: { titles: ['Product designer'], seniority: ['senior'], workModels: ['remote'], locations: [{ label: 'London', radiusKm: 40 }] },
    alertInstantMax: 0,
    alertDigest: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

/** Every read answered, every capability on, nothing waiting. */
export function sourcesWith(over: Partial<TodaySources> = {}): TodaySources {
  return {
    flags: { ready: true, agent: true, copilot: true, feed: true },
    search: ready(searchProfile()),
    queue: ready([]),
    picks: ready([]),
    picksFrom: 'suggestions',
    newJobs: ready({ count: 0, since: null, capped: false }),
    board: ready(board()),
    profileMissing: ready(0),
    resumes: ready([resume()]),
    setupStepsLeft: ready(0),
    skills: ready([]),
    ...over,
  };
}
