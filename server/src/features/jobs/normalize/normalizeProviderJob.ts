// server/src/features/jobs/normalize/normalizeProviderJob.ts
//
// normalizeProviderJob(raw, provider, ctx) → NormalizedJob — the single entry
// point the ingest pipeline (WP-16b), the ATS board sync (WP-42) and job
// import (WP-35) call before the upsert and `marketHooks.afterNormalize`.
// Pure and deterministic: no I/O, no clock reads except `ctx.now` (default:
// the time of the call), no LLM. Rules: ARCH §4.4; honesty: D3 / H9.

import type { Market } from '../../../platform/brand/index.js';
import type { MarketHookJob } from '../marketHooks.js';
import { bestTaxonomyMatch, taxonomyAncestors } from '../taxonomy/index.js';
import { parseLocation, resolveCountry, type ParsedLocation } from '../geo/index.js';
import { resolveIsAgency } from './agency.js';
import { atsTypeFromUrls } from './ats.js';
import { buildCompanyUpsert } from './company.js';
import { buildSearchText, dedupeKey, resolveExpiresAt, resolvePostedAt, toDate } from './identity.js';
import {
  educationFromLabel,
  educationFromText,
  employmentTypeFromLabel,
  employmentTypeFromTitle,
  roleTypeFromTitle,
  seniorityFromLabel,
  seniorityFromTitle,
  seniorityFromYears,
  yearsFromProvider,
  yearsFromText,
} from './level.js';
import { normalizeSalary } from './salary.js';
import { applicantCountAllowed, isLinkedInAssetHost, isLinkedInBranded, isLinkedInHost, PROVIDER_META, sourceFields } from './source.js';
import { asWritten, cleanOrNull, cleanText, hostOf, htmlToPlain, normalizeCompanyName, normalizeJobTitle, safeUrl, truncate } from './text.js';
import type { NormalizedJob, NormalizedLocation, NormalizeContext, NormalizeProvider, ProviderJobInput, Seniority } from './types.js';
import { resolveWorkModel } from './workModel.js';
import { foldTwToCn } from './zhVariants.js';

export const MAX_SKILLS = 25;

/** Lower-case, de-duplicated skills (max 25, each ≤ 60 chars). */
export function normalizeSkills(skills: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of skills ?? []) {
    if (typeof s !== 'string') continue;
    const v = s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!v || v.length > 60 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

/** [L1, L2, L3] ids for a title (empty when no role matches well enough; enrichment decides then). */
export function taxonomyIdsForTitle(title: string): { ids: string[]; primary: string | null } {
  // Taiwan titles (資料分析師) are folded to mainland vocabulary for the match only.
  const match = bestTaxonomyMatch(title) ?? (/[\u3400-\u9fff]/.test(title) ? bestTaxonomyMatch(foldTwToCn(title)) : null);
  if (!match) return { ids: [], primary: null };
  return { ids: taxonomyAncestors(match.id).map((n) => n.id).reverse(), primary: match.id };
}

function defaultMarket(provider: NormalizeProvider): Market {
  return provider === 'bank_gohire' ? 'cn' : 'intl';
}

// ── Location and the market it implies ────────────────────────────────────

interface ResolvedLocations {
  texts: string[];
  parsed: ParsedLocation[];
  primary: ParsedLocation | null;
  /** The provider's own (not search-copied) country for the posting. */
  providerCountry: string | null;
  /** The provider's own region field for the posting ("HK", "Taiwan", "Guangdong"). */
  providerRegion: string | null;
  searchCountry: string | null;
  hadHint: boolean;
}

/**
 * The provider's separate city / region / country fields describe the first
 * location only; for it the provider's country is binding (an ambiguous
 * "Cambridge" + GB is Cambridge, England). The search's country
 * (`countryHint`, or a country the provider copied from the search,
 * `locationCountryEstimated`) is a weak hint for every location: it picks
 * among same-name cities and fills a missing country. Later locations of a
 * multi-location post get the provider's country only as that weak hint.
 */
function resolveLocations(raw: ProviderJobInput, countryHint: string | null | undefined): ResolvedLocations {
  const texts = [...(raw.locations ?? []), raw.location].filter((t): t is string => typeof t === 'string' && !!t.trim());
  const providerCountry = raw.locationCountryEstimated ? null : cleanOrNull(raw.locationCountry);
  const searchCountry = cleanOrNull(countryHint) ?? (raw.locationCountryEstimated ? cleanOrNull(raw.locationCountry) : null);
  const providerHint = { city: cleanOrNull(raw.locationCity), region: cleanOrNull(raw.locationRegion), country: providerCountry, searchCountry };
  const laterHint = { searchCountry: providerCountry ?? searchCountry };
  const parsed = uniqueLocations(texts.map((t, i) => parseLocation(t, i === 0 ? providerHint : laterHint)));
  const hadHint = !!(providerHint.city || providerHint.region || providerHint.country || searchCountry);
  if (!parsed.length && hadHint) parsed.push(parseLocation('', providerHint));
  const primary = parsed.find((p) => p.city) ?? parsed.find((p) => p.cityName || p.country) ?? parsed[0] ?? null;
  return { texts, parsed, primary, providerCountry, providerRegion: cleanOrNull(raw.locationRegion), searchCountry, hadHint };
}

/** Hong Kong, Macau and Taiwan are not mainland China, however the text ends ("Hong Kong SAR, China"). */
const NOT_MAINLAND_RE = /hong\s*kong|\bhksar\b|\bmacau\b|\bmacao\b|\btaiwan\b|\btaipei\b|香港|澳门|澳門|台湾|台灣|臺灣/i;
/**
 * Districts and cities of Hong Kong, Macau and Taiwan that postings name
 * without those words ("Kowloon, China", "Tsim Sha Tsui" filed under country
 * cn, "Hsinchu, China"). Read only when the text resolved to no mainland city
 * or province, so 重庆市九龙坡区 and "Taoyuan, Hunan" stay mainland.
 */
const NOT_MAINLAND_PLACE_RE =
  /\bhk\b|\bkowloon\b|\bnew\s+territories\b|\bwan\s*chai\b|\btsim\s*sha\s*tsui\b|\bkwun\s*tong\b|\bcauseway\s*bay\b|\bsha\s*tin\b|\btsuen\s*wan\b|\bcotai\b|\btaipa\b|\bhsinchu\b|\bzhubei\b|\btaichung\b|\btainan\b|\bkaohsiung\b|\btaoyuan\b|九龙|九龍|新界|湾仔|灣仔|尖沙咀|观塘|觀塘|铜锣湾|銅鑼灣|沙田|荃湾|荃灣|路氹|氹仔|新竹|竹北|台中|臺中|台南|臺南|高雄|桃园|桃園|台北|臺北|新北/i;
const NOT_MAINLAND_COUNTRIES: ReadonlySet<string> = new Set(['HK', 'MO', 'TW']);
/** A region field that names Hong Kong, Macau or Taiwan (a code or the name). */
const isNotMainlandRegion = (region: string | null | undefined): boolean =>
  !!region && (/^(?:hk|mo|tw)$/i.test(region.trim()) || NOT_MAINLAND_RE.test(region));

/**
 * Is the posting's own (primary) location in mainland China? True only when
 * the posting itself says so: the location text names China or a mainland
 * city, or the provider states the country for this posting. A country that
 * was merely filled from a board tag or the search (a weak hint) never counts,
 * so a global board tagged CN does not turn its "Remote" postings mainland.
 *
 * Hong Kong, Macau and Taiwan are decided from the resolved place, not only
 * from those three words: some boards file them under country "cn"
 * (SmartRecruiters) or end the text with "China". A posting is not mainland
 * when its text or region names one of them, when the place it names is one
 * of their cities in the city table, or when it names one of their well-known
 * districts and neither a mainland city nor a mainland province was resolved.
 */
function isMainlandChina(loc: ResolvedLocations): boolean {
  const p = loc.primary;
  if (!p || p.country !== 'CN') return false;
  if (NOT_MAINLAND_RE.test(p.raw) || (p.cityName && NOT_MAINLAND_RE.test(p.cityName))) return false;
  if (isNotMainlandRegion(loc.providerRegion) || isNotMainlandRegion(p.region)) return false;
  if (!p.city && !p.region) {
    // Neither a mainland city nor a mainland province resolved: is the named place a Hong Kong, Macau or Taiwan one?
    if (NOT_MAINLAND_PLACE_RE.test(p.raw) || (p.cityName && NOT_MAINLAND_PLACE_RE.test(p.cityName))) return false;
    const elsewhere = p.cityName ? parseLocation(p.cityName).city : null;
    if (elsewhere && NOT_MAINLAND_COUNTRIES.has(elsewhere.country)) return false;
  }
  if (p.countrySource === 'hint') return resolveCountry(loc.providerCountry)?.code === 'CN';
  return true;
}

/**
 * The market an employer-board posting belongs to, from its own resolved
 * location: mainland China → 'cn', anything else → 'intl'. Each posting is in
 * exactly one market (GOAPPLY_PARITY_PLAN.md §3.9, MARKET_STRATEGY JC-4); a
 * posting with locations in both markets follows its primary location (the
 * second copy is the market wave's part of JC-4). The public board connectors
 * call this on the listing BEFORE their per-board cap; the normalizer applies
 * the same function, so the two can never disagree.
 */
export function marketOfPosting(raw: ProviderJobInput, countryHint: string | null = null): Market {
  return isMainlandChina(resolveLocations(raw, countryHint)) ? 'cn' : 'intl';
}

function toNormalizedLocation(p: ParsedLocation, market: Market): NormalizedLocation {
  const city = p.city ? (market === 'cn' ? (p.city.zh ?? p.city.name) : p.city.name) : p.cityName;
  return { city, cityId: p.city?.id ?? null, region: p.region, country: p.country, lat: p.lat, lng: p.lng };
}

/**
 * Normalize one provider job. Throws only on a programming error (unknown
 * provider); bad data degrades to nulls and `notes`.
 */
export function normalizeProviderJob(raw: ProviderJobInput, provider: NormalizeProvider, ctx: NormalizeContext = {}): NormalizedJob {
  const meta = PROVIDER_META[provider];
  if (!meta) throw new Error(`normalizeProviderJob: unknown provider ${String(provider)}`);
  const now = ctx.now ?? new Date();
  // ── Location (rules: resolveLocations above) and the market ──
  const located = resolveLocations(raw, ctx.countryHint);
  const { texts, parsed, primary, providerCountry } = located;
  // An employer-board posting's market is its own location, whatever market reads the board.
  const market: Market = provider === 'ats_public' ? (isMainlandChina(located) ? 'cn' : 'intl') : (ctx.market ?? defaultMarket(provider));
  const notes: string[] = [];
  const fieldSources: NormalizedJob['fieldSources'] = {};

  const title = truncate(cleanText(raw.title), 300);
  const companyName = truncate(cleanText(raw.company), 200);
  const titleNormalized = normalizeJobTitle(title);
  const companyNameNormalized = normalizeCompanyName(companyName) || companyName.toLowerCase();

  const descriptionRaw = cleanText(raw.descriptionHtml) || cleanText(raw.description);
  const descriptionPlain = htmlToPlain(descriptionRaw);
  // What the page shows: the posting's own text with its own punctuation (FIX-3). Everything parsed
  // from the description (pay, years, work model, search text) still reads the NFKC form above.
  const descriptionShown = asWritten(raw.descriptionHtml) || asWritten(raw.description);

  const locations = parsed.filter((p) => p.cityName || p.country).map((p) => toNormalizedLocation(p, market));
  const primaryLoc = primary ? toNormalizedLocation(primary, market) : null;
  if (primary?.country) {
    fieldSources.country =
      primary.countrySource === 'city_table'
        ? 'city_table'
        : primary.countrySource === 'hint'
          ? providerCountry && primary.country === resolveCountry(providerCountry)?.code
            ? 'provider'
            : 'query_country'
          : 'location_text';
  }

  // ── Work model ──
  const wm = resolveWorkModel({
    provider: raw.workModel,
    legacyWorkType: raw.workType,
    locationModels: parsed.map((p) => p.workModel),
    title,
    description: descriptionPlain,
  });
  if (wm) fieldSources.workModel = wm.source;
  const workModel = wm?.value ?? null;
  let remoteScope: string | null = cleanOrNull(raw.remoteScope);
  if (workModel === 'remote') remoteScope ??= parsed.map((p) => p.remoteScope).find((s) => s) ?? null;
  else remoteScope = null;

  // ── Employment type, level, years ──
  let employmentType = employmentTypeFromLabel(raw.employmentType);
  if (employmentType) fieldSources.employmentType = 'provider';
  else {
    employmentType = employmentTypeFromTitle(title);
    if (employmentType) fieldSources.employmentType = 'title';
  }

  // Education: the provider's label first, then the posting's own words (Chinese postings).
  let educationLevel = educationFromLabel(raw.educationLevel);
  let educationEvidence: string | null = null;
  if (educationLevel) fieldSources.educationLevel = 'provider';
  else {
    const stated = educationFromText(descriptionPlain);
    if (stated) {
      educationLevel = stated.level;
      educationEvidence = stated.quote;
      fieldSources.educationLevel = 'posting_text';
    }
  }

  let years = yearsFromProvider(raw.experienceLevel, raw.experienceMonths);
  if (years) fieldSources.years = 'provider';
  else {
    years = yearsFromText(descriptionPlain);
    if (years) fieldSources.years = 'description';
  }

  // A title that names an internship / campus hire (实习, 校招, New Grad) outranks a provider's generic level.
  const titleLevel = seniorityFromTitle(title);
  let seniority: Seniority | null = titleLevel === 'intern_newgrad' ? null : seniorityFromLabel(raw.seniority);
  if (seniority) fieldSources.seniority = 'provider';
  if (!seniority && titleLevel) {
    seniority = titleLevel;
    fieldSources.seniority = 'title';
  }
  if (!seniority && employmentType === 'internship') {
    seniority = 'intern_newgrad';
    fieldSources.seniority = 'employment_type';
  }
  if (!seniority && years?.min != null) {
    seniority = seniorityFromYears(years.min);
    if (seniority) fieldSources.seniority = 'years';
  }
  const roleType = roleTypeFromTitle(title);
  if (roleType) fieldSources.roleType = 'title';

  // ── Taxonomy and skills ──
  const tax = taxonomyIdsForTitle(title);
  if (tax.primary) fieldSources.taxonomy = 'title';
  const skills = normalizeSkills(raw.skills);
  if (skills.length) fieldSources.skills = 'provider';

  // ── Pay ──
  const salary = normalizeSalary({
    min: raw.salaryMin,
    max: raw.salaryMax,
    currency: raw.salaryCurrency,
    period: raw.salaryPeriod,
    text: raw.salaryText,
    months: raw.salaryMonths,
    description: descriptionPlain,
    country: primaryLoc?.country ?? null,
    market,
  });
  if (salary.salarySource) fieldSources.salary = salary.salarySource;
  if (raw.salaryCurrencyInferred && salary.salarySource === 'provider' && salary.salaryCurrency) notes.push('salary_currency_from_search_country');

  // ── Source line, ATS, agency ──
  const applyUrl = safeUrl(raw.applyUrl ?? null) ?? safeUrl(raw.sourceUrl ?? null);
  if (!applyUrl) notes.push('no_apply_url');
  // Kept (it may be the only way to apply); flagged so the ingest / job page can decide whether to show it.
  else if (isLinkedInHost(hostOf(applyUrl))) notes.push('apply_url_linkedin_host');
  // H9: no LinkedIn-hosted logo (media.licdn.com hotlinks) on the card.
  const logoUrl = safeUrl(raw.companyLogoUrl ?? null);
  const companyLogoUrl = logoUrl && !isLinkedInAssetHost(hostOf(logoUrl)) ? logoUrl : null;
  if (logoUrl && !companyLogoUrl) notes.push('linkedin_logo_dropped');
  const source = sourceFields({ provider, sourceBoard: raw.sourceBoard, sourcePublisher: raw.sourcePublisher, sourceUrl: raw.sourceUrl, applyUrl });
  if (isLinkedInBranded(raw.sourcePublisher)) notes.push('linkedin_publisher_dropped');
  const atsType = atsTypeFromUrls(applyUrl, raw.sourceUrl);
  // The company record: our staffing-firm list, the name, or the provider's own flag.
  const companyIsAgency = resolveIsAgency(companyName, raw.isAgency);
  // The job: also an agency posting when a recruiter placed it for a named employer (代招).
  const isAgency = raw.agencyPosting === true ? true : companyIsAgency;

  // ── Applicant count: a named, citable source only; never LinkedIn-derived ──
  let applicantCount: number | null = null;
  let applicantCountSource: string | null = null;
  let applicantCountAt: Date | null = null;
  if (raw.applicantCount != null) {
    const count = raw.applicantCount;
    const src = cleanOrNull(raw.applicantCountSource);
    if (!applicantCountAllowed(provider)) notes.push(`applicant_count_dropped:${provider}`);
    else if (!src || isLinkedInBranded(src)) notes.push('applicant_count_dropped:no_citable_source');
    else if (Number.isInteger(count) && count >= 0) {
      applicantCount = count;
      applicantCountSource = src;
      applicantCountAt = toDate(raw.applicantCountAt ?? null) ?? toDate(raw.fetchedAt ?? null) ?? now;
    }
  }

  // ── Dates ──
  const posted = resolvePostedAt(raw.postedAt ?? null, { estimated: raw.postedAtEstimated, fetchedAt: raw.fetchedAt, firstSeenAt: ctx.firstSeenAt, now });
  const expiresAt = resolveExpiresAt(provider, raw.expiresAt ?? null, posted.postedAt);

  // ── Visibility and display ──
  const isBank = meta.fromRecruiterBank;
  const visibility = provider === 'user_import' ? 'private' : 'public';
  const publicDisplay = provider === 'user_import' ? false : isBank ? raw.syndicationConsent === true : (ctx.publicDisplayProviders ?? []).includes(provider);

  const place = { cityId: primaryLoc?.cityId ?? null, city: primary?.city?.name ?? primary?.cityName ?? null, remoteScope, country: primaryLoc?.country ?? null };

  const coverage = {
    taxonomy: !!tax.primary,
    seniority: !!seniority,
    skills: skills.length,
    complete: !!tax.primary && !!seniority && skills.length >= 5,
  };

  return {
    provider,
    market,
    visibility,
    ownerUserId: provider === 'user_import' ? (ctx.ownerUserId ?? null) : null,
    externalId: cleanText(raw.externalId),
    sourceBoard: source.sourceBoard,
    sourcePriority: source.sourcePriority,

    title,
    titleNormalized,
    companyName,
    companyNameNormalized,
    companyLogoUrl,

    applyUrl,
    sourceUrl: source.sourceUrl,
    sourceName: source.sourceName,
    originalSourceName: source.originalSourceName,
    originalHost: source.originalHost,
    atsType,
    isAgency,
    fromRecruiterBank: source.fromRecruiterBank,
    employerVerified: isBank && raw.employerVerified === true,
    publicDisplay,

    location: cleanOrNull(raw.location) ?? cleanOrNull(texts[0]),
    locationCity: primaryLoc?.city ?? null,
    locationRegion: primaryLoc?.region ?? null,
    locationCountry: primaryLoc?.country ?? null,
    locations,
    geoLat: primaryLoc?.lat ?? null,
    geoLng: primaryLoc?.lng ?? null,
    workModel,
    remoteScope,

    employmentType,
    educationLevel,
    educationEvidence,
    headcount: typeof raw.headcount === 'number' && Number.isInteger(raw.headcount) && raw.headcount > 0 ? raw.headcount : null,
    ...salary,

    taxonomyIds: tax.ids,
    primaryTaxonomyId: tax.primary,
    seniority,
    roleType,
    minYears: years?.min ?? null,
    maxYears: years?.max ?? null,
    skills,

    description: descriptionShown,
    descriptionPlain,

    postedAt: posted.postedAt,
    postedAtEstimated: posted.estimated,
    expiresAt,

    applicantCount,
    applicantCountSource,
    applicantCountAt,

    dedupeKey: dedupeKey(companyNameNormalized, titleNormalized, place),
    searchText: buildSearchText(titleNormalized, companyNameNormalized, skills),

    company: buildCompanyUpsert({
      market,
      displayName: companyName,
      nameNormalized: companyNameNormalized,
      logoUrl: companyLogoUrl,
      isAgency: companyIsAgency,
      bankCompanyRef: raw.bankCompanyRef ?? null,
      facts: raw.companyFacts,
      logoSource: `provider:${provider}`,
      now,
    }),
    fieldSources,
    coverage,
    notes,
  };
}

/** A NormalizedJob is a MarketHookJob (compile-time proof; identity at run time) for `marketHooks.afterNormalize`. */
export function asMarketHookJob(job: NormalizedJob): MarketHookJob {
  return job;
}

/** Locations for the same place collapse (multi-location posts often repeat one). */
function uniqueLocations(list: ParsedLocation[]): ParsedLocation[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    if (!p.raw && !p.cityName && !p.country && !p.workModel) return false;
    const key = p.city?.id ?? `${p.cityName ?? ''}|${p.region ?? ''}|${p.country ?? ''}|${p.workModel ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
