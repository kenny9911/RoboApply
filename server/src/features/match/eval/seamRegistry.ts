// server/src/features/match/eval/seamRegistry.ts
//
// Every surface that shows a fit (strategy 2.2, invariant I1): feed card, job
// detail, Similar jobs, alert selection, the Ready list, the Assistant, the
// extension chip, the tailoring kit and the onboarding result. Invariant 3
// iterates this registry: for one seeded user and job it reads each seam and
// compares the score, tier and kind with `getFit`. A seam that is missing
// fails BY NAME.
//
// Created by MKT-1D with the seam names; the reads were wired by MKT-2F
// (phase M2), when every consumer had moved to `getFit` / `getFits`.
//
// How a read is built:
//   - It runs the surface's OWN code (its service, or the one function its
//     production wiring calls) on the fakes of `ctx.world`: the same in-memory
//     repository, the same counting scorer, the same brand and clock `getFit`
//     was read from. Only the fit functions and the storage around them are
//     fakes; the mapping from a `Fit` to what the surface shows is the
//     production mapping, so a surface that maps wrongly disagrees here.
//   - Nothing under test is imported statically (seams.ts): a module is a
//     repository path and an export, loaded at run time. A surface that was
//     removed or renamed fails with that path, never with a compile error in
//     an unrelated build.
//   - No read may call the scorer. Two surfaces can ask for a model result by
//     design (the Assistant's analyze_fit and the tailoring session at
//     creation). Their reads are taken the way the surface shows a fit that
//     already exists: see the comment on each.
//
// Adding a surface that shows a fit means adding an entry here AND to the
// reader list of eval/enforced.test.ts, which fails when a source file reads
// the fit contract without being listed. A name in REQUIRED_FIT_SEAMS may
// never be removed.

import type { MatchJobRecord } from '../context.js';
import { searchProfileWire } from '../testkit.js';
import { SeamMissing, loadSeam, type FitLike } from './seams.js';
import type { World } from './world.js';

/** What a surface shows for (user, job): the three fields I1 compares. */
export interface SeamReading {
  score: unknown;
  tier: unknown;
  /** 'ai' | 'estimate' ('pre' is accepted as the wire spelling of an estimate). */
  kind: unknown;
}

export interface SeamContext {
  /** The world `getFit` was read from: one repository, one scorer, one brand, one clock. */
  world: World;
  /** Whether the world holds a fresh stored AI fit for the pair (`ai`) or none (`estimate`). */
  scenario: 'estimate' | 'ai';
}

export interface FitSeam {
  /** Stable name; printed when the seam is missing or disagrees. */
  name: string;
  /** The surface, in words. */
  surface: string;
  /** Repository path of the module that serves the surface. */
  modulePath: string;
  read(userId: string, jobId: string, ctx: SeamContext): Promise<SeamReading>;
}

/** The surfaces invariant I1 names. Every one must be in the registry. */
export const REQUIRED_FIT_SEAMS = [
  'feed_card',
  'job_detail',
  'similar_jobs',
  'alert_selection',
  'ready_list',
  'assistant_stored_fit',
  'assistant_analyze_fit',
  'extension_chip',
  'tailoring_kit',
  'onboarding_result',
] as const;

// ── Shared pieces ─────────────────────────────────────────────────────────

type AnyFn = (...args: never[]) => unknown;
type Loose = Record<string, unknown>;

const F = 'server/src/features';
const PATHS = {
  feedService: `${F}/feed/FeedQueryService.ts`,
  feedTestkit: `${F}/feed/testkit.ts`,
  jobDetail: `${F}/jobs/detail/service.ts`,
  alerts: `${F}/alerts/service.ts`,
  agentDeps: `${F}/agent/deps.ts`,
  copilotAreas: `${F}/copilot/areas.ts`,
  copilotJobTools: `${F}/copilot/tools/jobs.ts`,
  extensionDeps: `${F}/extension/defaultDeps.ts`,
  tailorService: `${F}/resume/tailor/TailorService.ts`,
  tailorFitDeps: `${F}/resume/tailor/fitDeps.ts`,
  onboardingMatch: `${F}/onboarding/match.ts`,
  onboardingTestkit: `${F}/onboarding/testkit.ts`,
  matchService: `${F}/match/MatchService.ts`,
  matchFit: `${F}/match/fit.ts`,
  fakePrisma: 'server/src/test/fakePrisma.ts',
  queue: 'server/src/platform/queue/index.ts',
} as const;

const DAY_MS = 86_400_000;

/** The fit functions of the world, exactly as the module returns them (a `Map` of `Fit`s), bound to the world's brand. */
async function fitsOf(world: World): Promise<{
  getFit: (userId: string, jobId: string, opts?: Loose) => Promise<FitLike>;
  getFits: (userId: string, jobIds: string[], opts?: Loose) => Promise<Map<string, FitLike>>;
  getVariantFit: (userId: string, jobId: string, variantId: string, opts?: Loose) => Promise<FitLike>;
}> {
  const api = await world.fit();
  return {
    getFit: (userId, jobId, opts) => api.raw.getFit(userId, jobId, opts) as Promise<FitLike>,
    getFits: (userId, jobIds, opts) => api.raw.getFits(userId, jobIds, opts) as Promise<Map<string, FitLike>>,
    getVariantFit: async (userId, jobId, variantId) => {
      if (!api.getVariantFit) throw new SeamMissing(`${PATHS.matchFit}#getVariantFit`);
      return api.getVariantFit(userId, jobId, variantId);
    },
  };
}

/** The job as the world's match repository holds it. */
function worldJob(world: World, jobId: string): MatchJobRecord {
  const job = world.repo.state.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`the world holds no job "${jobId}": a seam can only be read for a seeded job`);
  return job;
}

/** A surface that answered nothing for the pair: said by name (a surface with no fit to show cannot agree with `getFit`). */
function reading(seam: string, value: { score?: unknown; tier?: unknown; kind?: unknown } | null | undefined): SeamReading {
  if (!value) throw new Error(`${seam} answered no fit for the job`);
  return { score: value.score ?? null, tier: value.tier ?? null, kind: value.kind };
}

/** An address a synthetic row links to (reserved for tests; nothing is fetched). */
const applyUrlOf = (job: MatchJobRecord) => (job.market === 'cn' ? `https://careers.example.cn/jobs/${job.id}` : `https://careers.example.test/jobs/${job.id}`);

// ── feed_card ─────────────────────────────────────────────────────────────

/** The world's job as the feed's row (the list projection: no long text), posted yesterday. */
function feedRowOf(job: MatchJobRecord, now: Date): Loose {
  return {
    id: job.id,
    market: job.market,
    visibility: job.visibility,
    ownerUserId: job.ownerUserId,
    title: job.title,
    titleNormalized: job.title.toLowerCase(),
    companyName: job.companyName,
    companyNameNormalized: job.companyName.toLowerCase(),
    taxonomyIds: job.taxonomyIds,
    primaryTaxonomyId: job.primaryTaxonomyId,
    seniority: job.seniority,
    minYears: job.minYears,
    maxYears: job.maxYears,
    educationLevel: job.educationLevel,
    skills: job.skills,
    skillsDetail: job.skillsDetail,
    workModel: job.workModel,
    remoteScope: job.remoteScope,
    location: job.location,
    locationCity: job.locationCity,
    locationCountry: job.locationCountry,
    geoLat: job.geoLat,
    geoLng: job.geoLng,
    salaryAnnualMin: job.salaryAnnualMin,
    salaryAnnualMax: job.salaryAnnualMax,
    salaryCurrency: job.salaryCurrency,
    salaryText: job.salaryText ?? null,
    sponsorship: job.sponsorship,
    sponsorshipEvidence: job.sponsorshipEvidence,
    marketTags: job.marketTags,
    archivedAt: job.archivedAt,
    companyIndustries: job.companyIndustries,
    skillIds: job.skillIds ?? [],
    contentHash: job.contentHash ?? null,
    lang: job.lang ?? null,
    titleMatchScore: job.titleMatchScore ?? null,
    applyUrl: applyUrlOf(job),
    sourceUrl: applyUrlOf(job),
    postedAt: new Date(now.getTime() - DAY_MS),
    firstSeenAt: new Date(now.getTime() - DAY_MS),
    lastSeenAt: new Date(now.getTime() - 3_600_000),
  };
}

async function readFeedCard(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const createFeedQueryService = await loadSeam<(deps: Loose) => Record<string, (...args: unknown[]) => Promise<unknown>>>(`${PATHS.feedService}#createFeedQueryService`);
  const createMatchService = await loadSeam<(deps: unknown) => Loose>(`${PATHS.matchService}#createMatchService`);
  const FakeFeedRepo = await loadSeam<new () => { rows: unknown[] }>(`${PATHS.feedTestkit}#FakeFeedRepo`);
  const feedRow = await loadSeam<(over: Loose) => Loose>(`${PATHS.feedTestkit}#feedRow`);
  const fits = await fitsOf(world);
  const repo = new FakeFeedRepo();
  repo.rows.push(feedRow(feedRowOf(worldJob(world, jobId), world.now)));
  // A saved search with no filters: every row is listed. (The fit reads the person's own search from the match repository.)
  const profile = searchProfileWire({ filters: {}, version: 1 });
  const service = createFeedQueryService({
    repo,
    match: { ...createMatchService(world.deps), getFits: fits.getFits, getFit: fits.getFit },
    search: { getActive: async () => profile, get: async () => profile },
    personalized: async () => true,
    consumeRefresh: async () => ({ allowed: true, retryAfterSec: 0 }),
    aiAllowed: world.deps.aiAllowed,
    planner: (text: string, ctx: unknown) => world.planner.plan(text, ctx),
    postingsAllowed: () => true,
    embeddings: world.embeddings,
    env: {},
    now: () => world.now,
  });
  const ctx = { userId, market: world.brand.market, brandId: world.brand.id, now: world.now };
  const page = (await world.inBrand(() => service.query!(ctx, { sort: 'recommended' }))) as { items?: Array<{ jobId: string; fit?: SeamReading | null }> };
  const item = page.items?.find((i) => i.jobId === jobId);
  if (!item) throw new Error('the feed did not list the job');
  return reading('the feed card', item.fit);
}

// ── job_detail and similar_jobs ───────────────────────────────────────────

/** The world's job as the job page's row: public, canonical, open, with a link. */
function detailRowOf(job: MatchJobRecord, now: Date, over: Loose = {}): Loose {
  return {
    id: job.id,
    externalId: `eval-${job.id}`,
    title: job.title,
    titleNormalized: job.title.toLowerCase(),
    companyId: null,
    companyName: job.companyName,
    companyLogoUrl: null,
    location: job.location,
    locationCountry: job.locationCountry,
    workModel: job.workModel,
    employmentType: 'full_time',
    seniority: job.seniority,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: job.salaryCurrency,
    salaryPeriod: null,
    salaryText: job.salaryText ?? null,
    salaryDisclosed: false,
    description: job.description,
    qualifications: job.qualifications,
    responsibilities: job.responsibilities,
    benefits: job.benefits,
    summary: null,
    skillsDetail: job.skillsDetail,
    sponsorship: job.sponsorship,
    sponsorshipEvidence: job.sponsorshipEvidence,
    marketTags: job.marketTags,
    fraudFlags: null,
    applyUrl: applyUrlOf(job),
    atsType: null,
    postedAt: new Date(now.getTime() - DAY_MS),
    postedAtEstimated: false,
    lastSeenAt: now,
    closedAt: null,
    archivedAt: null,
    sourceBoard: 'activejobs',
    sourceName: 'Eval source (synthetic)',
    originalSourceName: null,
    sourceUrl: null,
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: null,
    market: job.market,
    visibility: job.visibility,
    ownerUserId: job.ownerUserId,
    isCanonical: true,
    publicDisplay: false,
    slug: null,
    primaryTaxonomyId: job.primaryTaxonomyId,
    locations: null,
    descriptionPlain: job.descriptionPlain,
    salaryMonths: null,
    expiresAt: null,
    ...over,
  };
}

async function jobDetailOn(world: World, rows: Loose[], deps: Loose): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const createJobDetailService = await loadSeam<(deps: Loose) => Record<string, (...args: unknown[]) => Promise<unknown>>>(`${PATHS.jobDetail}#createJobDetailService`);
  const createFakePrisma = await loadSeam<(options: { seed: Record<string, Loose[]> }) => unknown>(`${PATHS.fakePrisma}#createFakePrisma`);
  const db = createFakePrisma({
    seed: { rAJob: rows, rATrackerEntry: [], rATrackerEvent: [], rAJobUserState: [], rAJobInteraction: [], rAResumeVariant: [], rACoverLetter: [], rACampusEvent: [] },
  });
  return createJobDetailService({
    db,
    brand: () => world.brand,
    now: () => world.now,
    // Nothing set: GoApply postings are shown (the default, D5).
    env: {},
    isEnabled: async () => true,
    // The 个性化推荐 grant is live: this registry is about what a fit shows, and no fit is shown without it.
    personalized: async () => true,
    ...deps,
  });
}

async function readJobDetail(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const fits = await fitsOf(world);
  // The production wiring: `getFit(userId, jobId)`, no model call (jobs/detail/defaultService.ts).
  const service = await jobDetailOn(world, [detailRowOf(worldJob(world, jobId), world.now)], { fit: (u: string, j: string) => fits.getFit(u, j) });
  const page = (await world.inBrand(() => service.get!(userId, jobId))) as { fit?: SeamReading | null };
  return reading('the job page', page.fit);
}

async function readSimilarJobs(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const fits = await fitsOf(world);
  const job = worldJob(world, jobId);
  // Another posting of the same market and country is on screen; the job is one of its similar jobs.
  const anchor = detailRowOf(job, world.now, { id: `${jobId}-anchor`, externalId: `eval-${jobId}-anchor`, title: `${job.title} (anchor)` });
  const service = await jobDetailOn(world, [anchor, detailRowOf(job, world.now)], {
    fits: (u: string, ids: string[]) => fits.getFits(u, ids),
    // The vector source names the job (the retrieval area's read in production).
    similarSource: async () => [jobId],
  });
  const list = (await world.inBrand(() => service.similar!(userId, `${jobId}-anchor`))) as { items?: Array<{ jobId: string; fit?: SeamReading | null }> };
  const item = list.items?.find((i) => i.jobId === jobId);
  if (!item) throw new Error('Similar jobs did not list the job');
  return reading('the Similar jobs card', item.fit);
}

// ── alert_selection ───────────────────────────────────────────────────────

/** The part of a sent alert card (alerts/service.ts `AlertCard`) this registry reads. */
interface AlertCardLike {
  tier?: unknown;
  kind?: unknown;
  fit?: SeamReading | null;
}

async function readAlertSelection(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const createJobAlertsTask = await loadSeam<(getDeps: () => unknown) => (ctx: Loose) => Promise<unknown>>(`${PATHS.alerts}#createJobAlertsTask`);
  const scoredFromFits = await loadSeam<(fits: Map<string, FitLike>, snapshot: AnyFn) => Array<SeamReading & { jobId: string; snapshot?: SeamReading | null }>>(`${PATHS.alerts}#scoredFromFits`);
  const fitSnapshot = await loadSeam<AnyFn>(`${PATHS.matchFit}#fitSnapshot`);
  const createBudget = await loadSeam<(ms: number) => unknown>(`${PATHS.queue}#createBudget`);
  const fits = await fitsOf(world);
  const job = worldJob(world, jobId);
  /** What the selection read for the job, and the card it sent (when the fit was good enough to alert). */
  let selected: (SeamReading & { snapshot?: SeamReading | null }) | null = null;
  let sent: AlertCardLike | null = null;
  const profile = { id: 'sp-eval', userId, name: 'Eval search', filters: {}, alertInstantMax: 5, alertDigest: null, alertLastInstantAt: null, alertLastDigestAt: null };
  const recipient = { userId, brand: world.brand.id, email: null, locale: 'en', timeZone: 'UTC', seekerProfileId: null };
  const deps = {
    repo: {
      dueProfiles: async ({ afterId }: { afterId: string | null }) => (afterId ? [] : [profile]),
      recipients: async () => new Map([[userId, recipient]]),
      excludedJobIds: async () => new Set<string>(),
      instantCountsSince: async () => ({ total: 0, byProfile: new Map<string, number>() }),
      claimInstant: async () => true,
      claimDigest: async () => true,
      releaseInstant: async () => undefined,
      releaseDigest: async () => undefined,
      createDelivery: async () => ({ id: 'delivery-eval' }),
      setDeliveryEmailLog: async () => undefined,
      jobCards: async (ids: string[]) =>
        ids.includes(jobId)
          ? [{ id: jobId, title: job.title, companyName: job.companyName, location: job.location, locationCity: job.locationCity, workModel: job.workModel, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, salaryText: null, salaryDisclosed: false }]
          : [],
      noReplyCount: async () => 0,
    },
    candidates: async () => ({ ids: [jobId], truncated: false }),
    // Noon UTC is outside the quiet hours.
    prefs: { load: async () => ({ userId, brand: world.brand.id, tipsGranted: null, marketingGranted: null, country: null, prefs: {}, timeZone: 'UTC', quietHours: { start: '21:00', end: '08:00' } }) },
    // The production mapping (alerts/service.ts `defaultJobAlertsDeps`): `scoredFromFits(getFits, fitSnapshot)`.
    fits: async (u: string, ids: string[]) => {
      const scored = scoredFromFits(await fits.getFits(u, ids), fitSnapshot);
      selected = scored.find((s) => s.jobId === jobId) ?? null;
      return scored;
    },
    planInstantMax: async () => 100,
    deliver: async (msg: { params?: { jobs?: Array<AlertCardLike & { id: string }> } }) => {
      sent = msg.params?.jobs?.find((j) => j.id === jobId) ?? null;
      return { notificationId: null, email: null, channels: {} };
    },
    alertsEnabled: () => true,
  };
  await world.inBrand(() => createJobAlertsTask(() => deps)({ name: 'job-alerts', brand: world.brand, budget: createBudget(240_000), now: world.now }));
  const read = selected as (SeamReading & { snapshot?: SeamReading | null }) | null;
  if (!read) throw new Error('the alert selection read no fit for the job');
  const card = sent as AlertCardLike | null;
  // A job the alert did not send (its fit is below Possible): what the selection read is all there is.
  if (!card) return reading('the alert selection', read.snapshot ?? read);
  // A job the alert did send carries the snapshot of that same fit (I6) ...
  if (JSON.stringify(card.fit) !== JSON.stringify(read.snapshot)) throw new Error('the alert card carries another fit than the selection read');
  // ... and what the reader SEES is the card: its own tier and kind (the mail and the notification print
  // `card.tier` and `card.kind`), with the score of the snapshot beside them. A card that showed another
  // tier than the fit (for example a thin estimate relabelled Possible) disagrees with `getFit` here.
  return reading('the alert card', { score: card.fit?.score, tier: card.tier, kind: card.kind });
}

// ── ready_list ────────────────────────────────────────────────────────────

async function readReadyList(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const readyListFits = await loadSeam<(userId: string, jobIds: string[], reads: Loose) => Promise<Map<string, SeamReading>>>(`${PATHS.agentDeps}#readyListFits`);
  const fits = await fitsOf(world);
  // The production function behind `defaultAgentDeps().fitsFor`, with the 个性化推荐 grant live.
  const rows = await world.inBrand(() => readyListFits(userId, [jobId], { personalized: async () => true, getFits: fits.getFits }));
  return reading('the Ready to apply row', rows.get(jobId));
}

// ── The Assistant ─────────────────────────────────────────────────────────

async function assistantAreas(world: World, fits: Loose): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const createDefaultAreas = await loadSeam<(options: Loose) => Record<string, (...args: unknown[]) => Promise<unknown>>>(`${PATHS.copilotAreas}#createDefaultAreas`);
  return createDefaultAreas({ store: {}, env: {}, fits });
}

async function readAssistantStoredFit(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const areas = await assistantAreas(world, await fitsOf(world));
  // A resume attached to the thread cannot matter: the adapter takes no version (copilot/types.ts `storedFit`).
  const view = (await world.inBrand(() => areas.storedFit!(userId, jobId, { locale: 'en' }))) as SeamReading;
  return reading('the Assistant (stored fit)', view);
}

/**
 * analyze_fit asks for the free on-demand score, so with nothing stored and a
 * model it may use it would CREATE the AI fit (that is its job; the job
 * page's POST /jobs/:id/score does the same). I1 is about what surfaces show
 * at the same time, so the `estimate` reading is taken at a moment no new
 * model result can appear for this person: the day's allowance is used up
 * (the counters of this one service refuse). The repository, the scorer, the
 * brand and the clock are the world's. With a stored AI fit, or with AI off
 * for the person, the world's own functions are used unchanged: no model runs
 * then, and that is the part invariant I8 reads.
 */
async function readAssistantAnalyzeFit(userId: string, jobId: string, { world, scenario }: SeamContext): Promise<SeamReading> {
  const analyzeFit = await loadSeam<{ run(args: Loose, ctx: Loose): Promise<{ data?: Loose }> }>(`${PATHS.copilotJobTools}#analyzeFit`);
  let fits: Loose = await fitsOf(world);
  const aiAllowed = world.deps.aiAllowed ? await world.deps.aiAllowed(userId) : true;
  if (scenario === 'estimate' && aiAllowed) {
    const createMatchService = await loadSeam<(deps: unknown) => { fits: Record<string, (...args: unknown[]) => Promise<unknown>> }>(`${PATHS.matchService}#createMatchService`);
    const capped = createMatchService({ ...world.deps, consume: async () => ({ allowed: false, retryAfterSec: 3600, remaining: 0, windows: [] }) }).fits;
    fits = {
      getFit: (...args: unknown[]) => world.inBrand(() => capped.getFit!(...args)),
      getVariantFit: (...args: unknown[]) => world.inBrand(() => capped.getVariantFit!(...args)),
    };
  }
  const areas = await assistantAreas(world, fits);
  let n = 0;
  const out = await world.inBrand(() =>
    analyzeFit.run(
      { jobId },
      // A thread with another resume attached: the tool must still answer the main resume's fit.
      { userId, brand: world.brand, market: world.brand.market, locale: 'en', now: world.now, resumeId: 'attached-to-the-thread', scope: 'seeker', areas, newCardId: () => `card-${++n}` },
    ),
  );
  const data = out.data ?? {};
  if (data.available === false) throw new Error(`analyze_fit answered "${String(data.reason)}"`);
  // The tool says a quick estimate in words for the model; the kind is the first word of that.
  return reading('the Assistant (analyze_fit)', { score: data.score, tier: data.tier, kind: String(data.kind).startsWith('quick estimate') ? 'estimate' : data.kind });
}

// ── extension_chip ────────────────────────────────────────────────────────

async function readExtensionChip(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const extensionMatchDeps = await loadSeam<(fits: Loose) => { cached(userId: string, jobId: string): Promise<SeamReading | null> }>(`${PATHS.extensionDeps}#extensionMatchDeps`);
  // The production wiring of the chip (`defaultExtensionDeps().match`) on the world's fit functions.
  const chip = await world.inBrand(async () => extensionMatchDeps(await fitsOf(world)).cached(userId, jobId));
  return reading('the extension chip', chip);
}

// ── tailoring_kit ─────────────────────────────────────────────────────────

/**
 * "Your fit" of the tailoring kit: `TailorService.yourFit`, the read the
 * session view makes (no model call), on the production wiring of the two
 * tailoring fits (`tailorFitDeps`). The kit SHOWS the number only when it is
 * an AI fit (D3: never an estimate in that comparison); what it reads is THE
 * fit either way, and that is what is compared here. Creating a session may
 * call the model once for the same canonical fit; that path writes the row
 * `getFit` then answers, so it cannot disagree afterwards.
 */
async function readTailoringKit(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const TailorService = await loadSeam<new (deps: Loose) => { yourFit(userId: string, jobId: string): Promise<SeamReading | null> }>(`${PATHS.tailorService}#TailorService`);
  const tailorFitDeps = await loadSeam<(fits: Loose) => Loose>(`${PATHS.tailorFitDeps}#tailorFitDeps`);
  const service = new TailorService({ ...tailorFitDeps(await fitsOf(world)), now: () => world.now });
  return reading('the tailoring kit ("Your fit")', await world.inBrand(() => service.yourFit(userId, jobId)));
}

// ── onboarding_result ─────────────────────────────────────────────────────

async function readOnboardingResult(userId: string, jobId: string, { world }: SeamContext): Promise<SeamReading> {
  const runOnboardingMatch = await loadSeam<(deps: Loose, userId: string) => Promise<{ topJobIds?: string[] } | null>>(`${PATHS.onboardingMatch}#runOnboardingMatch`);
  const fitsForRanking = await loadSeam<(fits: Map<string, FitLike>) => FitLike[]>(`${PATHS.onboardingMatch}#fitsForRanking`);
  const createMemoryRepo = await loadSeam<(seed: Loose) => { repo: unknown; addResume(userId: string, resume: Loose): void; setCandidates(ids: string[]): void }>(`${PATHS.onboardingTestkit}#createMemoryRepo`);
  const basics = await loadSeam<Loose>(`${PATHS.onboardingTestkit}#SAMPLE_BASICS`);
  const fits = await fitsOf(world);
  const mem = createMemoryRepo({ [userId]: { step: 'matching', path: 'urgent', answers: { basics: { ...basics }, resume: { resumeVariantId: 'rv-eval' } } } });
  mem.addResume(userId, { id: 'rv-eval', parsedData: {}, resumeMarkdown: 'text' });
  mem.setCandidates([jobId]);
  /** What the run ranked the job by. */
  let ranked: FitLike | null = null;
  const result = await world.inBrand(() =>
    runOnboardingMatch(
      {
        repo: mem.repo,
        brand: { id: world.brand.id, market: world.brand.market },
        now: () => world.now.getTime(),
        applyAnswers: async () => ({ id: 'sp-eval', version: 1 }),
        ingest: async () => ({}),
        // The production mapping (onboarding/defaults.ts): `fitsForRanking(getFits(userId, ids))`.
        fits: async (u: string, ids: string[]) => {
          const list = fitsForRanking(await fits.getFits(u, ids));
          ranked = list.find((f) => f.jobId === jobId) ?? null;
          return list;
        },
        aiAllowed: world.deps.aiAllowed,
        // The run may queue an AI read of its top jobs; nothing is scored here.
        enqueue: async () => undefined,
      },
      userId,
    ),
  );
  const read = ranked as FitLike | null;
  if (!read) throw new Error('the onboarding run read no fit for the job');
  if (read.score !== null && !result?.topJobIds?.includes(jobId)) throw new Error('the onboarding result does not list the job it ranked');
  return reading('the onboarding result', read);
}

// ── The registry ──────────────────────────────────────────────────────────

export const FIT_SEAMS: FitSeam[] = [
  { name: 'feed_card', surface: 'Feed card (POST /feed/query, item.fit)', modulePath: PATHS.feedService, read: readFeedCard },
  { name: 'job_detail', surface: 'Job detail fit (GET /jobs/:id)', modulePath: PATHS.jobDetail, read: readJobDetail },
  { name: 'similar_jobs', surface: 'Similar jobs cards', modulePath: PATHS.jobDetail, read: readSimilarJobs },
  { name: 'alert_selection', surface: 'Job alert selection (notification and mail cards)', modulePath: PATHS.alerts, read: readAlertSelection },
  { name: 'ready_list', surface: 'Ready to apply list (fitsFor)', modulePath: PATHS.agentDeps, read: readReadyList },
  { name: 'assistant_stored_fit', surface: 'Assistant: stored fit of a job it lists', modulePath: PATHS.copilotAreas, read: readAssistantStoredFit },
  { name: 'assistant_analyze_fit', surface: 'Assistant: analyze_fit tool', modulePath: PATHS.copilotJobTools, read: readAssistantAnalyzeFit },
  { name: 'extension_chip', surface: 'Browser extension fit chip', modulePath: PATHS.extensionDeps, read: readExtensionChip },
  { name: 'tailoring_kit', surface: 'Tailoring kit: "Your fit" (the canonical fit)', modulePath: PATHS.tailorService, read: readTailoringKit },
  { name: 'onboarding_result', surface: 'Onboarding result (the jobs the first run ranks)', modulePath: PATHS.onboardingMatch, read: readOnboardingResult },
];
