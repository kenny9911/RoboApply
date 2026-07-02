// backend/src/lib/linkedin/linkedInImport.ts
//
// "Import from LinkedIn" provider seam for RoboApply resumes.
//
// LinkedIn has no usable public API for a member's full profile and blocks
// scraping, so there are exactly TWO realistic, ToS-compliant ways to get a
// candidate's profile into a résumé:
//
//   1. PDF EXPORT (always available, free) — the member opens their profile,
//      "More → Save to PDF", and uploads that PDF. We run it through the SAME
//      candidate parse pipeline as a normal upload (see RAResumeService /
//      candidateResumeIngest). The only LinkedIn-specific bit there is
//      `cleanLinkedInExportText`, a light pre-clean of the extracted text.
//
//   2. URL ENRICHMENT (optional, config-gated) — paste a public profile URL
//      and a third-party enrichment API (Proxycurl-compatible by default)
//      fetches the structured profile. This costs money per lookup, so it is
//      INERT until `LINKEDIN_ENRICH_API_KEY` is configured. The frontend reads
//      `isLinkedInUrlImportConfigured()` (via /resumes/import-linkedin/config)
//      to decide whether to even offer the URL field.
//
// This module lives in `lib/` (not under `roboapply/v2/`) so the boundary-
// locked V2 service may import it (lib/* is allowed; services/* is not). It is
// free to reach `services/*` itself because the V2 boundary checker only scans
// files under `backend/src/roboapply/v2/`.
//
// Quota: nothing here debits. LinkedIn import is FREE, exactly like a normal
// résumé upload-parse.

import { logger } from '../../services/LoggerService.js';

/** Stable error codes surfaced to the route → client (for localized copy). */
export type LinkedInImportErrorCode =
  | 'url_import_not_configured'
  | 'invalid_url'
  | 'fetch_failed'
  | 'profile_empty';

export class LinkedInImportError extends Error {
  code: LinkedInImportErrorCode;
  constructor(code: LinkedInImportErrorCode, message: string) {
    super(message);
    this.name = 'LinkedInImportError';
    this.code = code;
  }
}

// ── Config ───────────────────────────────────────────────────────────────

/** Default enrichment endpoint — Proxycurl's Person Profile API. Override with
 *  `LINKEDIN_ENRICH_API_URL` to point at any provider that takes a profile URL
 *  query param + Bearer auth and returns a JSON profile. */
const DEFAULT_ENRICH_API_URL = 'https://nubela.co/proxycurl/api/v2/linkedin';
/** Proxycurl reads the profile URL from `linkedin_profile_url`. Override with
 *  `LINKEDIN_ENRICH_URL_PARAM` for other providers (e.g. `url`). */
const DEFAULT_ENRICH_URL_PARAM = 'linkedin_profile_url';
const ENRICH_TIMEOUT_MS = 25_000;
/** Hard ceiling on the enrichment response body — a well-behaved provider
 *  returns a few KB of JSON. Guards against a compromised/misconfigured/MITM'd
 *  upstream buffering an enormous body into memory. */
const MAX_ENRICH_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
/** Cap on the rendered résumé text fed into the parse pipeline + DB row. */
const MAX_PROFILE_TEXT_CHARS = 200_000;

/** True when URL-based import is configured (an enrichment API key is set).
 *  Read at CALL TIME so an admin setting the key needs no redeploy. */
export function isLinkedInUrlImportConfigured(): boolean {
  return !!process.env.LINKEDIN_ENRICH_API_KEY?.trim();
}

// ── URL normalization ──────────────────────────────────────────────────────

/**
 * Validate + canonicalize a LinkedIn profile URL. Accepts inputs with or
 * without scheme/`www`, country subdomains (`uk.linkedin.com`), trailing
 * slashes, and query strings. Returns the canonical
 * `https://www.linkedin.com/in/<handle>` form, or `null` if it is not a
 * recognizable LinkedIn member profile URL.
 */
export function normalizeLinkedInUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  // Member profiles live under /in/<handle>. Public profiles sometimes use
  // /pub/<...>; we only support /in/ (the Save-to-PDF + enrichment shape).
  const match = url.pathname.match(/\/in\/([^/?#]+)/i);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]).trim();
  if (!handle) return null;

  return `https://www.linkedin.com/in/${encodeURIComponent(handle)}`;
}

// ── LinkedIn "Save to PDF" text cleaner ──────────────────────────────────────

/**
 * Light, conservative cleanup of text extracted from a LinkedIn "Save to PDF"
 * export before it hits the résumé parse agent. LinkedIn PDFs interleave a
 * "Contact" / "Top Skills" sidebar and stamp a `Page N of M` footer on every
 * page; the footer in particular pollutes the parse. We strip only the
 * unambiguous boilerplate and leave the real content untouched — the parse
 * agent is robust to the rest.
 */
export function cleanLinkedInExportText(text: string): string {
  if (!text || typeof text !== 'string') return text ?? '';
  const cleaned = text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      // "Page 1 of 3" footer stamped on each PDF page.
      if (/^page\s+\d+\s+of\s+\d+$/i.test(t)) return false;
      return true;
    })
    .join('\n')
    // Collapse 3+ consecutive blank lines (left behind by sidebar columns).
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

// ── URL enrichment → résumé text ──────────────────────────────────────────

/** A Proxycurl-shaped date sub-object (`{ day, month, year }`). All optional. */
interface EnrichDate {
  day?: number | null;
  month?: number | null;
  year?: number | null;
}

function fmtDate(d?: EnrichDate | null): string {
  if (!d || typeof d !== 'object') return '';
  const y = typeof d.year === 'number' && d.year > 0 ? String(d.year) : '';
  const m =
    typeof d.month === 'number' && d.month >= 1 && d.month <= 12
      ? [
          'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
        ][d.month - 1]
      : '';
  return [m, y].filter(Boolean).join(' ');
}

function fmtRange(starts?: EnrichDate | null, ends?: EnrichDate | null): string {
  const s = fmtDate(starts);
  const e = fmtDate(ends);
  if (s && e) return `${s} – ${e}`;
  if (s && !e) return `${s} – Present`;
  return s || e || '';
}

function asStr(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Render an enrichment-API profile JSON into a plain-text résumé. The output is
 * intentionally text (not markdown): it is fed straight into the same
 * `ResumeParseAgent` path a real upload uses (as a `text/plain` buffer), so the
 * downstream structured parse, summary, and markdown serialization are
 * identical to every other résumé in the system.
 *
 * Defensive against partial / provider-specific shapes — every field is
 * optional and coerced. Modeled on Proxycurl's Person Profile shape but only
 * touches widely-shared field names.
 */
export function renderLinkedInProfileToText(profile: any): {
  text: string;
  displayName: string;
} {
  const p = profile && typeof profile === 'object' ? profile : {};
  const lines: string[] = [];

  const fullName =
    asStr(p.full_name) ||
    [asStr(p.first_name), asStr(p.last_name)].filter(Boolean).join(' ');
  if (fullName) lines.push(fullName);

  const headline = asStr(p.occupation) || asStr(p.headline);
  if (headline) lines.push(headline);

  const location =
    [asStr(p.city), asStr(p.state), asStr(p.country_full_name) || asStr(p.country)]
      .filter(Boolean)
      .join(', ');
  if (location) lines.push(location);

  const summary = asStr(p.summary);
  if (summary) {
    lines.push('', 'Summary', summary);
  }

  const experiences = Array.isArray(p.experiences) ? p.experiences : [];
  if (experiences.length) {
    lines.push('', 'Experience');
    for (const exp of experiences) {
      if (!exp || typeof exp !== 'object') continue;
      const title = asStr(exp.title);
      const company = asStr(exp.company);
      const header = [title, company].filter(Boolean).join(' at ');
      const range = fmtRange(exp.starts_at, exp.ends_at);
      const loc = asStr(exp.location);
      const meta = [range, loc].filter(Boolean).join(' · ');
      if (header || meta) lines.push('', [header, meta].filter(Boolean).join('  |  '));
      const desc = asStr(exp.description);
      if (desc) lines.push(desc);
    }
  }

  const education = Array.isArray(p.education) ? p.education : [];
  if (education.length) {
    lines.push('', 'Education');
    for (const ed of education) {
      if (!ed || typeof ed !== 'object') continue;
      const school = asStr(ed.school);
      const degree = [asStr(ed.degree_name), asStr(ed.field_of_study)]
        .filter(Boolean)
        .join(', ');
      const range = fmtRange(ed.starts_at, ed.ends_at);
      const parts = [school, degree, range].filter(Boolean);
      if (parts.length) lines.push('', parts.join(' · '));
    }
  }

  // Skills: top-level `skills` (Proxycurl) or accomplishment arrays.
  const skills = Array.isArray(p.skills)
    ? p.skills.map(asStr).filter(Boolean)
    : [];
  if (skills.length) {
    lines.push('', 'Skills', skills.join(', '));
  }

  const languages = Array.isArray(p.languages)
    ? p.languages.map(asStr).filter(Boolean)
    : [];
  if (languages.length) {
    lines.push('', 'Languages', languages.join(', '));
  }

  const certs = Array.isArray(p.certifications) ? p.certifications : [];
  if (certs.length) {
    const names = certs
      .map((c: any) => (c && typeof c === 'object' ? asStr(c.name) : asStr(c)))
      .filter(Boolean);
    if (names.length) lines.push('', 'Certifications', names.join('; '));
  }

  const text = lines.join('\n').trim();
  return { text, displayName: fullName || 'LinkedIn profile' };
}

/**
 * Fetch a LinkedIn profile via the configured enrichment API and render it to
 * plain-text résumé content. Throws `LinkedInImportError` with a stable `code`
 * for every failure mode so the route can map it to localized client copy.
 */
export async function fetchLinkedInProfileAsText(
  profileUrl: string,
  opts: { requestId?: string } = {},
): Promise<{ text: string; displayName: string; canonicalUrl: string }> {
  if (!isLinkedInUrlImportConfigured()) {
    throw new LinkedInImportError(
      'url_import_not_configured',
      'LinkedIn URL import is not configured on this deployment.',
    );
  }

  const canonicalUrl = normalizeLinkedInUrl(profileUrl);
  if (!canonicalUrl) {
    throw new LinkedInImportError(
      'invalid_url',
      'That does not look like a LinkedIn profile URL.',
    );
  }

  const apiUrl = process.env.LINKEDIN_ENRICH_API_URL?.trim() || DEFAULT_ENRICH_API_URL;
  const urlParam =
    process.env.LINKEDIN_ENRICH_URL_PARAM?.trim() || DEFAULT_ENRICH_URL_PARAM;
  const apiKey = process.env.LINKEDIN_ENRICH_API_KEY!.trim();

  const endpoint = new URL(apiUrl);
  endpoint.searchParams.set(urlParam, canonicalUrl);

  // Keep the abort timer armed across BOTH the fetch AND the body read — fetch()
  // resolves on response headers, so reading the body separately would otherwise
  // be an unbounded wait on a slow/large upstream. A single try/finally clears
  // the timer only after the body is fully consumed (or aborted).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS);
  let profile: any;
  try {
    const res = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn(
        'LINKEDIN_IMPORT',
        'enrichment returned non-2xx',
        { status: res.status },
        opts.requestId,
      );
      throw new LinkedInImportError(
        'fetch_failed',
        `The LinkedIn data provider returned ${res.status}.`,
      );
    }

    // Reject an oversized body up front when the provider advertises its size.
    const lenHeader = Number(res.headers.get('content-length') || '');
    if (Number.isFinite(lenHeader) && lenHeader > MAX_ENRICH_RESPONSE_BYTES) {
      throw new LinkedInImportError('fetch_failed', 'The LinkedIn data provider returned an oversized response.');
    }
    const raw = await res.text();
    if (raw.length > MAX_ENRICH_RESPONSE_BYTES) {
      throw new LinkedInImportError('fetch_failed', 'The LinkedIn data provider returned an oversized response.');
    }
    try {
      profile = JSON.parse(raw);
    } catch {
      throw new LinkedInImportError('fetch_failed', 'The LinkedIn data provider returned an unreadable response.');
    }
  } catch (err) {
    if (err instanceof LinkedInImportError) throw err;
    // Network error, timeout/abort, or body-read failure.
    logger.warn(
      'LINKEDIN_IMPORT',
      'enrichment request failed',
      { error: err instanceof Error ? err.message : String(err) },
      opts.requestId,
    );
    throw new LinkedInImportError('fetch_failed', 'Could not reach the LinkedIn data provider.');
  } finally {
    clearTimeout(timer);
  }

  const rendered = renderLinkedInProfileToText(profile);
  // Cap the rendered text so a fat upstream payload can't bloat the LLM call / DB row.
  const text = rendered.text.slice(0, MAX_PROFILE_TEXT_CHARS);
  const displayName = rendered.displayName;
  if (!text || text.trim().length < 20) {
    throw new LinkedInImportError('profile_empty', 'No usable profile data was returned.');
  }

  return { text, displayName, canonicalUrl };
}
