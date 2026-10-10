// lib/api/resumes.ts — Resume suite additions: grade, issue fixes, keyword report, tailor sessions, layout.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-22 → WP-36a/36b → WP-65.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// WP-36b moved the resume CRUD here from the frozen lib/api/v2 client (same
// endpoints, same responses, plus the additive hub fields), and the binary
// export download from lib/resumeDownload.ts (deleted).
//
// Endpoints:
//   GET    /api/v1/roboapply/v2/resumes
//   POST   /api/v1/roboapply/v2/resumes
//   POST   /api/v1/roboapply/v2/resumes/upload                 (multipart)
//   POST   /api/v1/roboapply/v2/resumes/import-linkedin        (multipart; the user's own PDF export)
//   GET    /api/v1/roboapply/v2/resumes/:id
//   PATCH  /api/v1/roboapply/v2/resumes/:id
//   DELETE /api/v1/roboapply/v2/resumes/:id
//   POST   /api/v1/roboapply/v2/resumes/:id/primary
//   GET    /api/v1/roboapply/v2/resumes/:id/export             (binary PDF/DOCX)
//   POST   /api/v1/roboapply/v2/resumes/:id/rewrite
//   GET    /api/v1/roboapply/v2/resumes/:id/coach-tips
//   POST   /api/v1/roboapply/v2/resumes/tailor-sessions
//   GET    /api/v1/roboapply/v2/resumes/tailor-sessions/:id
//   PATCH  /api/v1/roboapply/v2/resumes/tailor-sessions/:id/claims/:claimId
//   POST   /api/v1/roboapply/v2/resumes/tailor-sessions/:id/finalize
//   POST   /api/v1/roboapply/v2/resumes/grades/:gradeId/cancel
//   POST   /api/v1/roboapply/v2/resumes/:id/grade
//   GET    /api/v1/roboapply/v2/resumes/:id/grade/latest      (?opened=1 from the report page: markResumeCheckOpened)
//   POST   /api/v1/roboapply/v2/resumes/:id/issues/:issueId/fix
//   POST   /api/v1/roboapply/v2/resumes/:id/issues/:issueId/apply
//   POST   /api/v1/roboapply/v2/resumes/:id/keyword-report
//   PATCH  /api/v1/roboapply/v2/resumes/:id/layout
//   POST   /api/v1/roboapply/v2/resumes/:id/export             (binary; with a device photo, WP-65)
//   POST   /api/v1/roboapply/v2/resumes/:id/fit-to-page        (WP-65)
//   GET    /api/v1/roboapply/v2/resumes/builder/config         (WP-65)
//   POST   /api/v1/roboapply/v2/resumes/builder/suggest        (WP-65)
//   POST   /api/v1/roboapply/v2/resumes/builder                (WP-65)

import { apiUrl, call, type CallOptions, type In, type Out, seg, withQuery } from './contracts/wire';
import type * as R from './contracts/resume';
import { RoboApiError, devBrandHeader, request } from './client';
import { LOCALE_COOKIE } from '../localeConfig';
import type {
  RAResumeKind,
  RAResumeVariant,
  RAResumeVariantSummary,
  ResumeCoachTipsResponse,
  ResumeCreateBody,
  ResumePatchBody,
  ResumeRewriteBody,
  ResumeRewriteResponse,
} from './v2/types';

const BASE = '/api/v1/roboapply/v2/resumes';

// ── Hub types (additive over the legacy V2 shapes) ─────────────────────────

/** `RAResumeVariant.layout` as the editor reads and writes it. */
export type ResumeLayout = Out<typeof R.ResumeLayoutSchema>;
export type ResumeTemplate = (typeof R.RESUME_TEMPLATES)[number];
export type ResumePage = 'letter' | 'a4';

/** A resume variant with the hub fields (WP-36b). */
export interface ResumeVariant extends RAResumeVariant {
  layout?: ResumeLayout | null;
  targetTitle?: string | null;
  /** Inserted claims not verified yet; >0 blocks export. */
  unverifiedClaims?: number;
  /** True when AI wrote part of this resume. */
  aiAssisted?: boolean;
  /** Letter or A4 for this visitor when the layout sets none (GET /:id, PATCH /:id/layout). */
  defaultPage?: ResumePage;
}

export interface ResumeSummary extends RAResumeVariantSummary {
  targetTitle?: string | null;
  basedOnVariantId?: string | null;
  unverifiedClaims?: number;
  /**
   * The tailor session still in review that made this version (set only while
   * `unverifiedClaims > 0`): `/resume?tailorSession=<id>` re-opens Verify details.
   */
  tailorSessionId?: string | null;
}

export interface ResumeListResult {
  resumes: ResumeSummary[];
}

/** Base resumes a user may keep (Free and Pro); tailored versions do not count. */
export const BASE_RESUME_LIMIT = 5;
/** Kinds that take a base slot. */
export const BASE_SLOT_KINDS: readonly RAResumeKind[] = ['base', 'from_template'];

export interface ResumeHubPatch extends ResumePatchBody {
  /** The job title this resume is aimed at; '' clears it. */
  targetTitle?: string | null;
  /** AI-written text landed in this save (exports then carry the AI marks). */
  aiAssisted?: boolean;
}

/** File-name presets (the agent contract's FILE_NAME_STYLES). */
export const FILE_NAME_STYLES = ['name_company_role', 'name_role', 'company_role_name', 'name_date'] as const;
export type FileNameStyle = (typeof FILE_NAME_STYLES)[number];
export type ResumeExportFormat = 'pdf' | 'docx';

export interface ResumeExportOptions {
  format: ResumeExportFormat;
  nameStyle?: FileNameStyle | null;
  /** Record the exact file on this application. */
  trackerEntryId?: string | null;
  /**
   * A photo kept on this device (JPEG/PNG data URL). Sent with the request
   * (POST), placed by the renderer, never stored on the server (WP-65).
   */
  photo?: string | null;
}

export interface ResumeExportResult {
  fileName: string;
  /** The RAApplicationArtifact id when the file was recorded on an application. */
  artifactId: string | null;
  /** A file recorded on an application (stored) is made without the photo, on every brand. */
  photoOmitted?: boolean;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/** `GET /v2/resumes` — every variant, newest edit first. */
export function listResumes(params?: { kind?: RAResumeKind }, opts?: CallOptions): Promise<ResumeListResult> {
  return call<ResumeListResult>('GET', withQuery(BASE, params), opts);
}

/** `GET /v2/resumes/:id` */
export async function getResume(id: string, opts?: CallOptions): Promise<ResumeVariant> {
  const r = await call<{ resume: ResumeVariant }>('GET', `${BASE}/${seg(id)}`, opts);
  return r.resume;
}

/** `POST /v2/resumes` — 409 `resume_limit_reached` when every base slot is taken. */
export async function createResume(body: ResumeCreateBody, opts?: CallOptions): Promise<ResumeVariant> {
  const r = await call<{ resume: ResumeVariant }>('POST', BASE, { ...opts, body });
  return r.resume;
}

/** `PATCH /v2/resumes/:id` — name, markdown, target title. */
export async function patchResume(id: string, body: ResumeHubPatch, opts?: CallOptions): Promise<ResumeVariant> {
  const r = await call<{ resume: ResumeVariant }>('PATCH', `${BASE}/${seg(id)}`, { ...opts, body });
  return r.resume;
}

/** `DELETE /v2/resumes/:id` (soft delete). */
export async function deleteResume(id: string, opts?: CallOptions): Promise<void> {
  await call<unknown>('DELETE', `${BASE}/${seg(id)}`, opts);
}

/** `POST /v2/resumes/:id/primary` */
export async function setPrimaryResume(id: string, opts?: CallOptions): Promise<ResumeVariant> {
  const r = await call<{ resume: ResumeVariant }>('POST', `${BASE}/${seg(id)}/primary`, { ...opts, body: {} });
  return r.resume;
}

/** SHA-256 of the file bytes: a retry of the same file replays the first upload. */
async function fileKey(file: File): Promise<string> {
  const fallback = `${file.name}:${file.size}:${file.lastModified}`;
  try {
    if (!globalThis.crypto?.subtle) return fallback;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return fallback;
  }
}

export interface UploadResumeOptions {
  name?: string;
  signal?: AbortSignal;
  /**
   * Read the file on our own servers only (no outside parsing service). The
   * server does this by itself for a user who has not agreed to
   * `intl_cross_border_cn_parse`; pass it to ask for it explicitly. RoboApply
   * only: GoApply ignores it (its parsing service is in-country).
   */
  localParser?: boolean;
}

/** Resume files a user may upload in a day; past it the server answers 429 `rate_limited` (`details.reason: resume_upload_daily_limit`). */
export const RESUME_UPLOADS_PER_DAY = 10;

/**
 * `POST /v2/resumes/upload` (multipart) — parse a file into a new base resume.
 * 409 `resume_limit_reached` when every base slot is taken; 429 `rate_limited`
 * with `Retry-After` past RESUME_UPLOADS_PER_DAY; 422 `image_parse_unavailable`
 * when an image cannot be read right now (GoApply).
 */
export async function uploadResume(file: File, opts?: UploadResumeOptions): Promise<ResumeVariant> {
  const fd = new FormData();
  fd.append('idempotencyKey', await fileKey(file));
  fd.append('file', file);
  if (opts?.name) fd.append('name', opts.name);
  if (opts?.localParser) fd.append('localParser', '1');
  const r = await request<{ resume: ResumeVariant }>('POST', `${BASE}/upload`, { body: fd, multipart: true, signal: opts?.signal });
  return r.resume;
}

/** `POST /v2/resumes/import-linkedin` — the user's own LinkedIn "Save to PDF" export. */
export async function importLinkedInPdf(file: File, opts?: { name?: string; signal?: AbortSignal }): Promise<ResumeVariant> {
  const fd = new FormData();
  fd.append('mode', 'pdf');
  fd.append('file', file);
  if (opts?.name) fd.append('name', opts.name);
  const r = await request<{ resume: ResumeVariant }>('POST', `${BASE}/import-linkedin`, { body: fd, multipart: true, signal: opts?.signal });
  return r.resume;
}

/** `POST /v2/resumes/:id/rewrite` (inline AI; 503 ai_unavailable without consent). */
export function rewriteResumeText(id: string, body: ResumeRewriteBody, opts?: CallOptions): Promise<ResumeRewriteResponse> {
  return call<ResumeRewriteResponse>('POST', `${BASE}/${seg(id)}/rewrite`, { ...opts, body });
}

/** `GET /v2/resumes/:id/coach-tips` (free, deterministic). */
export function getCoachTips(id: string, opts?: CallOptions): Promise<ResumeCoachTipsResponse> {
  return call<ResumeCoachTipsResponse>('GET', `${BASE}/${seg(id)}/coach-tips`, opts);
}

// ── Export (binary) ────────────────────────────────────────────────────────

/** The export URL (also usable as a plain link where cookies authenticate). */
export function resumeExportUrl(id: string, options: ResumeExportOptions): string {
  return apiUrl(
    withQuery(`${BASE}/${seg(id)}/export`, {
      format: options.format,
      nameStyle: options.nameStyle ?? undefined,
      trackerEntryId: options.trackerEntryId ?? undefined,
    }),
  );
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const row = document.cookie.split(/;\s*/).find((r) => r.startsWith(`${name}=`));
  if (!row) return null;
  try {
    return decodeURIComponent(row.slice(name.length + 1)) || null;
  } catch {
    return null;
  }
}

/** Pull the filename from Content-Disposition (RFC 5987 `filename*` first, so CJK names survive). */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      /* fall through */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1]! : fallback;
}

/**
 * Fetch the server-rendered export and save it in the browser. Rejects with
 * `RoboApiError` on a non-2xx (`unverified_claims` 409 carries
 * `details.count`), so callers can read `apiErrorCode(err)`.
 */
export async function downloadResumeExport(id: string, options: ResumeExportOptions, fallbackName: string): Promise<ResumeExportResult> {
  const headers: Record<string, string> = {};
  if (typeof window !== 'undefined') {
    try {
      const bearer = window.localStorage.getItem('auth_token');
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
    } catch {
      // storage unavailable — the cookie still authenticates
    }
  }
  const locale = readCookie(LOCALE_COOKIE);
  if (locale) headers['X-Robo-Locale'] = locale;
  const devBrand = devBrandHeader();
  if (devBrand) headers['X-RA-Brand'] = devBrand;

  let res: Response;
  try {
    if (options.photo) {
      // WP-65: the photo travels in the body, never in a URL.
      headers['Content-Type'] = 'application/json';
      res = await fetch(apiUrl(`${BASE}/${seg(id)}/export`), {
        method: 'POST',
        credentials: 'include',
        headers,
        cache: 'no-store',
        body: JSON.stringify({
          format: options.format,
          nameStyle: options.nameStyle ?? undefined,
          trackerEntryId: options.trackerEntryId ?? undefined,
          photo: options.photo,
        }),
      });
    } else {
      res = await fetch(resumeExportUrl(id, options), { method: 'GET', credentials: 'include', headers, cache: 'no-store' });
    }
  } catch (err) {
    throw new RoboApiError(err instanceof Error ? err.message : 'Network error', { code: 'network_error' });
  }
  if (!res.ok) {
    let data: { error?: string; code?: string } = {};
    try {
      data = await res.json();
    } catch {
      // non-JSON error body
    }
    throw new RoboApiError(data.error ?? `HTTP ${res.status}`, { code: data.code, status: res.status, payload: data });
  }
  const blob = await res.blob();
  const fileName = filenameFromDisposition(res.headers.get('Content-Disposition'), `${fallbackName || 'resume'}.${options.format}`);
  if (typeof document !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }
  const result: ResumeExportResult = { fileName, artifactId: res.headers.get('X-Artifact-Id') };
  if (res.headers.get('X-Photo-Omitted') === '1') result.photoOmitted = true;
  return result;
}

/** `resume.createTailorSession` — POST /api/v1/roboapply/v2/resumes/tailor-sessions */
export function createTailorSession(body: In<typeof R.CreateTailorSessionBodySchema>, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('POST', `/api/v1/roboapply/v2/resumes/tailor-sessions`, { ...opts, body });
}

/** `resume.getTailorSession` — GET /api/v1/roboapply/v2/resumes/tailor-sessions/:id */
export function getTailorSession(id: string, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('GET', `/api/v1/roboapply/v2/resumes/tailor-sessions/${seg(id)}`, opts);
}

/** `resume.updateClaim` — PATCH /api/v1/roboapply/v2/resumes/tailor-sessions/:id/claims/:claimId */
export function updateTailorClaim(id: string, claimId: string, body: In<typeof R.UpdateClaimBodySchema>, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('PATCH', `/api/v1/roboapply/v2/resumes/tailor-sessions/${seg(id)}/claims/${seg(claimId)}`, { ...opts, body });
}

/** `resume.finalizeTailor` — POST /api/v1/roboapply/v2/resumes/tailor-sessions/:id/finalize */
export function finalizeTailorSession(id: string, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('POST', `/api/v1/roboapply/v2/resumes/tailor-sessions/${seg(id)}/finalize`, opts);
}

/** `resume.cancelGrade` — POST /api/v1/roboapply/v2/resumes/grades/:gradeId/cancel */
export function cancelGrade(gradeId: string, opts?: CallOptions): Promise<R.CancelGradeResponse> {
  return call<R.CancelGradeResponse>('POST', `/api/v1/roboapply/v2/resumes/grades/${seg(gradeId)}/cancel`, opts);
}

/**
 * `resume.grade` — POST /api/v1/roboapply/v2/resumes/:id/grade. Runs in the
 * request (≤45 s) and returns the finished check. Pass `idempotencyKey`: the
 * AI pass spends a `resume_check` credit.
 */
export function startGrade(id: string, body: In<typeof R.GradeBodySchema> = {}, opts?: CallOptions): Promise<R.GradeStartResponse> {
  return call<R.GradeStartResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/grade`, { ...opts, body });
}

/** `resume.latestGrade` — GET /api/v1/roboapply/v2/resumes/:id/grade/latest */
export function getLatestGrade(id: string, opts?: CallOptions): Promise<R.LatestGradeResponse> {
  return call<R.LatestGradeResponse>('GET', `/api/v1/roboapply/v2/resumes/${seg(id)}/grade/latest`, opts);
}

/**
 * `resume.latestGrade` with `?opened=1` — the owner has the finished check on
 * screen. The server stamps the check as opened the first time; nothing else
 * changes. Only the report page calls this: the editor summary, tailoring and
 * the onboarding dock read `getLatestGrade` and must not count as opening it.
 */
export async function markResumeCheckOpened(id: string, opts?: CallOptions): Promise<void> {
  await call<R.LatestGradeResponse>('GET', withQuery(`/api/v1/roboapply/v2/resumes/${seg(id)}/grade/latest`, { opened: 1 }), opts);
}

/** `resume.fixIssue` — POST /api/v1/roboapply/v2/resumes/:id/issues/:issueId/fix */
export function fixIssue(id: string, issueId: string, body: In<typeof R.FixIssueBodySchema>, opts?: CallOptions): Promise<R.FixIssueResponse> {
  return call<R.FixIssueResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/issues/${seg(issueId)}/fix`, { ...opts, body });
}

/** `resume.applyFix` — POST /api/v1/roboapply/v2/resumes/:id/issues/:issueId/apply (replaces the issue's text in the resume) */
export function applyIssueFix(id: string, issueId: string, body: In<typeof R.ApplyFixBodySchema>, opts?: CallOptions): Promise<R.ApplyFixResponse> {
  return call<R.ApplyFixResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/issues/${seg(issueId)}/apply`, { ...opts, body });
}

/** `resume.keywordReport` — POST /api/v1/roboapply/v2/resumes/:id/keyword-report */
export function getKeywordReport(id: string, body: In<typeof R.KeywordReportBodySchema>, opts?: CallOptions): Promise<R.KeywordReportResponse> {
  return call<R.KeywordReportResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/keyword-report`, { ...opts, body });
}

// Merges into the stored layout and returns the variant (served by the legacy
// resumes router, mounted before the RES feature router).
/** `resume.layout` — PATCH /api/v1/roboapply/v2/resumes/:id/layout */
export function patchResumeLayout(id: string, body: In<typeof R.PatchLayoutBodySchema>, opts?: CallOptions): Promise<ResumeVariant> {
  return call<{ resume: ResumeVariant }>('PATCH', `/api/v1/roboapply/v2/resumes/${seg(id)}/layout`, { ...opts, body }).then((r) => r?.resume);
}

// ── WP-65: fit to page, guided builder ─────────────────────────────────────

export type FitToPageResponse = R.FitToPageResponse;
export type BuilderConfig = R.BuilderConfigView;
export type BuilderDraft = In<typeof R.BuilderDraftSchema>;
export type BuilderSuggestBody = In<typeof R.BuilderSuggestBodySchema>;
export type BuilderSuggestResponse = R.BuilderSuggestResponse;
export type BuilderCreateResponse = R.BuilderCreateResponse;
export type BuilderSection = R.BuilderSection;
export type BuilderDocLanguage = R.BuilderDocLanguage;
export type BuilderVariant = R.BuilderVariant;

/** `resume.fitToPage` — POST /api/v1/roboapply/v2/resumes/:id/fit-to-page */
export function fitResumeToPage(id: string, body: In<typeof R.FitToPageBodySchema>, opts?: CallOptions): Promise<R.FitToPageResponse> {
  return call<R.FitToPageResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/fit-to-page`, { ...opts, body });
}

/** `resume.builderConfig` — GET /api/v1/roboapply/v2/resumes/builder/config */
export function getBuilderConfig(opts?: CallOptions): Promise<R.BuilderConfigView> {
  return call<R.BuilderConfigView>('GET', `/api/v1/roboapply/v2/resumes/builder/config`, opts);
}

/** `resume.builderSuggest` — POST /api/v1/roboapply/v2/resumes/builder/suggest */
export function suggestBuilderText(body: In<typeof R.BuilderSuggestBodySchema>, opts?: CallOptions): Promise<R.BuilderSuggestResponse> {
  return call<R.BuilderSuggestResponse>('POST', `/api/v1/roboapply/v2/resumes/builder/suggest`, { ...opts, body });
}

/** `resume.builderCreate` — POST /api/v1/roboapply/v2/resumes/builder */
export function createResumeFromBuilder(body: In<typeof R.BuilderDraftSchema>, opts?: CallOptions): Promise<R.BuilderCreateResponse> {
  return call<R.BuilderCreateResponse>('POST', `/api/v1/roboapply/v2/resumes/builder`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const resumesApi = {
  listResumes,
  getResume,
  createResume,
  patchResume,
  deleteResume,
  setPrimaryResume,
  uploadResume,
  importLinkedInPdf,
  rewriteResumeText,
  getCoachTips,
  downloadResumeExport,
  createTailorSession,
  getTailorSession,
  updateTailorClaim,
  finalizeTailorSession,
  cancelGrade,
  startGrade,
  getLatestGrade,
  markResumeCheckOpened,
  fixIssue,
  applyIssueFix,
  getKeywordReport,
  patchResumeLayout,
  fitResumeToPage,
  getBuilderConfig,
  suggestBuilderText,
  createResumeFromBuilder,
};
