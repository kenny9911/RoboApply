// extension/src/content/fill.ts — one supervised fill of one form (ARCHITECTURE.md §6.4).
//
//   start(): reserve a run (autofill credit) → list fields → for each field,
//     the user's own value (profile, saved answers, resume file) is filled;
//     questions without one become "Needs you"; free-text questions that are
//     not protected can get a draft — on request — that appears ONLY here,
//     in the panel → PATCH the run (commits the credit when something was
//     filled, releases it otherwise).
//   useDraft(id): the explicit, per-field "Use this answer" click. It is the
//     only path by which AI text reaches a page field (apply() refuses AI
//     text for a field the user has not approved).
//   undo(): puts every changed field back where we can.
//   saveDraftAnswer(id): "Save this answer" — an answer the user used goes to
//     their saved answers (POST /ext/answers/save); never a protected question.
//   markSubmitted(): the user's answer to "Did you submit this application?" —
//     the only source of `userMarkedSubmitted`. Nothing here watches the page.
//
// One run per application (R4): a session lives as long as its panel. Filling
// again — the next page of a page-by-page form such as Workday, or a second
// pass on the same page — reuses the run and reports running totals, so one
// application uses one form-fill credit however many pages it has. A reloaded
// tab gets the same run back from the server (`reused`).
//
// Fill modes (GoApply 一键填表, WP-71): 全部填写 `all` (default), 只填空白
// `blank` (a field that already holds something is left as it is) and
// 填写选中区域 `selection` (only fields inside the part of the page the user
// selected; nothing is reserved or read when the selection holds no field).
// Portal adapters (adapters/cn) add a section-aware field map: education,
// experience and family rows, and the optional 籍贯 / 政治面貌 / 生源地 /
// 家庭成员 details, filled only from values the user entered.
//
// D1: nothing here presses Submit, Next or Continue; the adapter has no such
// method and interact.ts refuses submit-like controls.

import { restoreField } from '../adapters/_kit/fields';
import { isPlaceholderOption } from '../adapters/_kit/options';
import { CN_SENSITIVE_STORE_KEYS, planCnFields, resolveCnField, type CnFieldKey, type CnPlanEntry, type CnSection } from '../adapters/cn/fields';
import { isCnAdapter } from '../adapters/cn/kit';
import type { AtsAdapter, FieldHandle, FieldKey, FieldKind, FieldValue, FillFailure, FillResult, PreviousValue } from '../adapters/types';
import { classifyField } from '../mapping/classify';
import { protectedQuestionType } from '../mapping/questions';
import { resolveField } from '../mapping/resolve';
import { EXTENSION_ERROR_CODES, PROTECTED_QUESTION_TYPES, errorReason, type AnswerFieldType, type AutofillOutcome, type AutofillProfile, type ProtectedQuestionType } from '../shared/contract';
import type { ApiResult } from '../shared/messages';
import { newIdempotencyKey, type ExtApi } from './bridge';
import { apiPageUrl } from './pageUrl';

export type ItemStatus = 'filled' | 'needs_you' | 'skipped';
export type ItemSource = 'profile' | 'bank' | 'resume' | 'ai';
export type ItemNote =
  | 'protected'
  | 'no_value'
  | 'no_option'
  | 'not_pressed'
  | 'resume_unavailable'
  | 'cover_letter'
  | 'file_failed'
  | 'disabled'
  | 'undone'
  | 'ai_unavailable'
  | 'draft_failed'
  /** `blank` mode: the form already held a value; left as it is. */
  | 'has_value'
  /** A personal detail (性别, 出生日期, 身份证 …): only the user fills it. */
  | 'personal'
  /** A family-member row without a matching entry in the user's optional details. */
  | 'family_none'
  /** 籍贯 / 政治面貌 / family rows while the user has not turned on filling optional details (`autofill_sensitive`). */
  | 'sensitive_consent'
  /** About someone else (紧急联系人, 推荐人, 证明人 …): only the user fills it. */
  | 'other_person'
  /** Asked again under a heading we do not know: it may be about someone else. */
  | 'check_whose'
  /** A photo upload: only the user attaches one. */
  | 'photo';

/** 全部填写 / 只填空白 / 填写选中区域. */
export const FILL_MODES = ['all', 'blank', 'selection'] as const;
export type FillMode = (typeof FILL_MODES)[number];

export interface StartOptions {
  mode?: FillMode;
  /** `selection` mode: is this element inside the user's selection? Absent → nothing was selected. */
  inScope?: ((el: Element) => boolean) | null;
  /**
   * Which page of the form this pass fills (the step of a page-by-page form;
   * '' on a single-page form). A second pass with the same key replaces that
   * page's counts in the running totals; a new key adds to them.
   */
  pageKey?: string;
  /** The job the server matched for this page, when it became known after the session was created. */
  jobId?: string | null;
}

/** Why "Save this answer" did not save. */
export type SaveAnswerError = 'protected' | 'failed';

export interface Draft {
  text: string;
  /** 'ai' drafts are labelled as AI-written; 'bank' is a saved answer the server found. */
  source: 'ai' | 'bank';
  saveable: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  key: FieldKey | null;
  protectedType: ProtectedQuestionType | null;
  status: ItemStatus;
  source?: ItemSource;
  /** EEO or other sensitive answers: highlighted for the user to check. */
  sensitive?: boolean;
  note?: ItemNote;
  /** A draft can be requested for this question (free text, not protected, AI available). */
  canDraft: boolean;
  drafting?: boolean;
  /** Shown only in the panel until the user clicks "Use this answer". */
  draft?: Draft;
  /** The answer the user used can be saved to their saved answers ("Save this answer"). */
  savable?: { text: string };
  saving?: boolean;
  saved?: boolean;
  saveError?: SaveAnswerError;
  fileName?: string;
  /** Portal forms (cn): the field's key in the cn map, its section and whether it is a personal detail. */
  cnKey?: CnFieldKey | null;
  section?: CnSection;
  personal?: boolean;
}

export type SessionError =
  | 'credits_exhausted'
  | 'feature_disabled'
  | 'not_connected'
  | 'rate_limited'
  | 'network'
  | 'unknown'
  /** `selection` mode without a selection on the page. */
  | 'no_selection'
  /** `selection` mode: the selected part of the page holds no field. */
  | 'no_fields_in_selection';

export interface SessionState {
  phase: 'idle' | 'filling' | 'done' | 'error';
  runId: string | null;
  items: ChecklistItem[];
  error: SessionError | null;
  /** credits_exhausted: when the bucket resets (ISO), when the server said. */
  resetsAt: string | null;
  submitted: 'unknown' | 'yes' | 'not_yet';
  /** The job the server matched for this page; without one no tracker entry can move to Applied. */
  jobId: string | null;
  undo: { restored: number; notRestored: number } | null;
  /** The mode of the last start(). */
  mode: FillMode | null;
}

export interface FillSessionDeps {
  adapter: AtsAdapter;
  doc: Document;
  url: string;
  api: ExtApi;
  /** The job the server matched for this page (POST /ext/page-job), when any. */
  jobId?: string | null;
  /** AI drafts are offered (consent + model available, per /ext/me). */
  aiAvailable: boolean;
  /**
   * A page-by-page form (Workday …). When the server hands back the run of
   * this application after a reload, its counts are the earlier pages' and
   * this page's are added to them.
   */
  multiPage?: boolean;
  onChange?: (state: SessionState) => void;
}

/** The API accepts at most this many fields per run. */
const MAX_FIELDS = 1000;

const DRAFTABLE: ReadonlySet<FieldKind> = new Set(['text', 'textarea']);
const FILE_KINDS: ReadonlySet<FieldKind> = new Set(['file']);
/** Profile fields whose plain label is also a protected word ("Degree"): the profile answers them. */
const EDUCATION_KEYS: ReadonlySet<FieldKey> = new Set(['degree', 'school', 'discipline']);

function answerFieldType(kind: FieldKind): AnswerFieldType {
  if (kind === 'textarea') return 'textarea';
  if (kind === 'select' || kind === 'combobox') return 'select';
  if (kind === 'radio') return 'radio';
  if (kind === 'checkbox') return 'checkbox';
  return 'text';
}

function errorOf(res: ApiResult<unknown>): SessionError {
  if (res.ok) return 'unknown';
  switch (res.code) {
    case 'credits_exhausted':
    case 'feature_disabled':
    case 'not_connected':
    case 'rate_limited':
      return res.code;
    case 'unauthorized':
    case 'device_revoked':
      return 'not_connected';
    case 'network_error':
      return 'network';
    default:
      return 'unknown';
  }
}

function noteFor(reason: FillFailure | undefined): ItemNote {
  switch (reason) {
    case 'no_option':
      return 'no_option';
    case 'refused':
      return 'not_pressed';
    case 'disabled':
      return 'disabled';
    default:
      return 'no_value';
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class AiApprovalRequiredError extends Error {
  constructor(fieldId: string) {
    super(`An AI-written answer goes into a field only after the user clicks "Use this answer" for it (${fieldId}).`);
    this.name = 'AiApprovalRequiredError';
  }
}

export class FillSession {
  private state: SessionState;
  private fields = new Map<string, FieldHandle>();
  /** Per-field approvals from "Use this answer" clicks, consumed by the next apply(). */
  private approvals = new Set<string>();
  private log: Array<{ id: string; previous: PreviousValue }> = [];
  private aiAvailable: boolean;
  /** Counts the run already had when this session received it (a reused run of a page-by-page form). */
  private base = { filled: 0, total: 0 };
  /** Counts of the pages this session filled before the current one, by page key. */
  private pages = new Map<string, { filled: number; total: number }>();
  private pageKey = '';

  constructor(private readonly deps: FillSessionDeps) {
    this.aiAvailable = deps.aiAvailable;
    this.state = { phase: 'idle', runId: null, items: [], error: null, resetsAt: null, submitted: 'unknown', jobId: deps.jobId ?? null, undo: null, mode: null };
  }

  getState(): SessionState {
    return this.state;
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange?.(this.state);
  }

  private updateItem(id: string, patch: Partial<ChecklistItem>): void {
    this.set({ items: this.state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  }

  private item(id: string): ChecklistItem | undefined {
    return this.state.items.find((it) => it.id === id);
  }

  /**
   * The single place a value is written into a page field. AI text is refused
   * unless the user approved this exact field ("Use this answer").
   */
  private async apply(id: string, value: FieldValue, source: ItemSource): Promise<FillResult> {
    const field = this.fields.get(id);
    if (!field) return { ok: false, reason: 'not_found' };
    if (source === 'ai') {
      if (!this.approvals.has(id)) throw new AiApprovalRequiredError(id);
      this.approvals.delete(id);
    }
    const res = await this.deps.adapter.fill(field, value);
    if (res.ok && res.previous) this.log.push({ id, previous: res.previous });
    return res;
  }

  private filledCount(): number {
    return this.state.items.filter((it) => it.status === 'filled').length;
  }

  /** Running totals for the whole application: earlier pages plus the page being filled. */
  private totals(): { fieldsFilled: number; fieldsTotal: number } {
    let filled = this.base.filled + this.filledCount();
    let total = this.base.total + this.state.items.length;
    for (const [key, page] of this.pages) {
      if (key === this.pageKey) continue;
      filled += page.filled;
      total += page.total;
    }
    return { fieldsFilled: Math.min(filled, MAX_FIELDS), fieldsTotal: Math.min(total, MAX_FIELDS) };
  }

  private outcome(): AutofillOutcome {
    if (this.totals().fieldsFilled === 0) return 'failed';
    const open = this.state.items.some((it) => it.required && it.status !== 'filled');
    return open ? 'partial' : 'filled';
  }

  /** Remember the current page's counts before another pass replaces the checklist. */
  private keepPage(): void {
    if (this.state.runId && this.state.items.length) this.pages.set(this.pageKey, { filled: this.filledCount(), total: this.state.items.length });
  }

  async start(opts: StartOptions = {}): Promise<void> {
    if (this.state.phase === 'filling') return;
    const { adapter, doc, api } = this.deps;
    const mode: FillMode = opts.mode ?? 'all';

    const allFields = adapter.listFields(doc);
    let fields = allFields;
    if (mode === 'selection') {
      // Checked before anything is reserved or read: no selection, no run.
      const inScope = opts.inScope;
      if (!inScope) {
        this.set({ phase: 'error', error: 'no_selection', resetsAt: null, undo: null, mode });
        return;
      }
      fields = fields.filter((f) => inScope(f.element) || (f.group ?? []).some((r) => inScope(r)));
      if (fields.length === 0) {
        this.set({ phase: 'error', error: 'no_fields_in_selection', resetsAt: null, undo: null, mode });
        return;
      }
    }
    // A new pass: the last one's counts are kept, its Undo log and approvals end here.
    this.keepPage();
    this.pageKey = opts.pageKey ?? '';
    this.log = [];
    this.approvals.clear();
    const jobId = opts.jobId ?? this.state.jobId ?? this.deps.jobId ?? null;
    this.set({ phase: 'filling', error: null, resetsAt: null, undo: null, mode, items: [], jobId, submitted: this.state.submitted === 'yes' ? 'yes' : 'unknown' });

    let host = '';
    try {
      host = new URL(this.deps.url).hostname;
    } catch {
      host = '';
    }

    // One run per application: only the first pass asks for one.
    let runId = this.state.runId;
    if (!runId) {
      const run = await api({
        op: 'createRun',
        body: { host: host || 'unknown', atsType: adapter.id, url: apiPageUrl(this.deps.url), jobId: jobId ?? undefined, fieldsTotal: fields.length },
        idempotencyKey: newIdempotencyKey(),
      });
      if (!run.ok) {
        const details = run.details as { resetsAt?: string } | undefined;
        this.set({ phase: 'error', error: errorOf(run), resetsAt: typeof details?.resetsAt === 'string' ? details.resetsAt : null });
        return;
      }
      runId = run.data.runId;
      // The server handed back this application's run (a reloaded tab on a later page): keep its counts.
      if (run.data.reused && this.deps.multiPage) this.base = { filled: run.data.fieldsFilled ?? 0, total: run.data.fieldsTotal ?? 0 };
      this.set({ runId, jobId: jobId ?? run.data.jobId ?? null });
    }

    const profileRes = await api({ op: 'autofillProfile' });
    if (!profileRes.ok) {
      const totals = this.totals();
      await api({ op: 'patchRun', id: runId, body: { ...totals, outcome: totals.fieldsFilled > 0 ? 'partial' : 'failed' } });
      this.set({ phase: 'error', error: errorOf(profileRes), runId });
      return;
    }
    const profile: AutofillProfile = profileRes.data;

    this.fields = new Map(fields.map((f) => [f.id, f]));
    // Planned on the whole form, so a selection holding only the second family member's block is still row 2.
    const cnPlan: Map<string, CnPlanEntry> = isCnAdapter(adapter) ? planCnFields(adapter, allFields) : new Map();
    const items: ChecklistItem[] = fields.map((f) => {
      const cn = cnPlan.get(f.id);
      if (cn) {
        return {
          id: f.id,
          label: f.label,
          kind: f.kind,
          required: f.required,
          key: null,
          protectedType: protectedQuestionType(f.label),
          status: f.required ? 'needs_you' : 'skipped',
          canDraft: false,
          cnKey: cn.key,
          section: cn.section,
          personal: cn.personal,
        };
      }
      // A protected question wins over a profile key its label happens to
      // match, except for an adapter hint or an education field ("Degree").
      const classified = classifyField(f);
      const protectedType = protectedQuestionType(f.label);
      const key = classified && protectedType && !f.hint && !EDUCATION_KEYS.has(classified) ? null : classified;
      return {
        id: f.id,
        label: f.label,
        kind: f.kind,
        required: f.required,
        key,
        protectedType,
        status: f.required ? 'needs_you' : 'skipped',
        canDraft: false,
      };
    });
    this.set({ runId, items });

    for (const it of items) {
      const field = this.fields.get(it.id)!;
      if (mode === 'blank' && hasValue(field)) {
        this.updateItem(it.id, { status: 'skipped', note: 'has_value' });
        continue;
      }
      const cn = cnPlan.get(it.id);
      if (cn) {
        await this.fillCn(it, field, cn, profile);
        continue;
      }
      if (FILE_KINDS.has(it.kind)) {
        await this.fillFile(it, field, runId);
        continue;
      }
      const resolved = resolveField(field, it.key, it.protectedType, profile);
      if (resolved) {
        const res = await this.apply(it.id, resolved.value, resolved.source);
        if (res.ok) this.updateItem(it.id, { status: 'filled', source: resolved.source, sensitive: resolved.sensitive, note: undefined });
        else this.updateItem(it.id, { status: 'needs_you', note: noteFor(res.reason) });
        continue;
      }
      const draftable = !it.key && !it.protectedType && DRAFTABLE.has(it.kind) && this.aiAvailable;
      this.updateItem(it.id, {
        status: it.required ? 'needs_you' : 'skipped',
        note: it.protectedType ? 'protected' : 'no_value',
        canDraft: draftable,
      });
    }

    await api({ op: 'patchRun', id: runId, body: { ...this.totals(), outcome: this.outcome() } });
    this.set({ phase: 'done' });
  }

  /** A field the portal map owns: the user's own value, or a note saying why it is left. */
  private async fillCn(it: ChecklistItem, field: FieldHandle, cn: CnPlanEntry, profile: AutofillProfile): Promise<void> {
    if (cn.key === 'photo') {
      this.updateItem(it.id, { status: it.required ? 'needs_you' : 'skipped', note: 'photo' });
      return;
    }
    const resolved = resolveCnField(field, cn, profile);
    if (resolved) {
      const res = await this.apply(it.id, resolved.value, resolved.source);
      if (res.ok) this.updateItem(it.id, { status: 'filled', source: resolved.source, sensitive: resolved.sensitive, note: undefined });
      else this.updateItem(it.id, { status: 'needs_you', note: noteFor(res.reason) });
      return;
    }
    const note: ItemNote = cnNote(cn, it, profile);
    // An unknown question in an education / experience block can still get a draft; personal details and family rows never.
    const draftable = !cn.key && !cn.noDraft && !it.protectedType && DRAFTABLE.has(it.kind) && this.aiAvailable;
    this.updateItem(it.id, { status: it.required ? 'needs_you' : 'skipped', note, canDraft: draftable });
  }

  private async fillFile(it: ChecklistItem, field: FieldHandle, runId: string): Promise<void> {
    if (it.key === 'coverLetter') {
      this.updateItem(it.id, { status: 'needs_you', note: 'cover_letter' });
      return;
    }
    if (it.key !== 'resume') {
      this.updateItem(it.id, { status: it.required ? 'needs_you' : 'skipped', note: 'no_value' });
      return;
    }
    // With a matched job: the copy tailored for it when one is ready. Without
    // one (a form outside the user's listings) the server sends the main resume.
    const jobId = this.state.jobId;
    const meta = await this.deps.api({ op: 'resumeForJob', body: jobId ? { jobId, runId } : { runId } });
    if (!meta.ok) {
      this.updateItem(it.id, { status: 'needs_you', note: 'resume_unavailable' });
      return;
    }
    const file = await this.deps.api({ op: 'fetchFile', url: meta.data.downloadUrl });
    if (!file.ok) {
      this.updateItem(it.id, { status: 'needs_you', note: 'file_failed' });
      return;
    }
    const name = meta.data.fileName || file.data.fileName || 'resume.pdf';
    const blob = new File([base64ToBytes(file.data.base64)], name, { type: file.data.contentType });
    const res = await this.deps.adapter.attachFile(field, blob);
    if (res.ok) {
      if (res.previous) this.log.push({ id: it.id, previous: res.previous });
      this.updateItem(it.id, { status: 'filled', source: 'resume', fileName: name, note: undefined });
    } else {
      this.updateItem(it.id, { status: 'needs_you', note: 'file_failed' });
    }
  }

  /** "Write a draft": ask for an answer; it is shown in the panel only. */
  async requestDraft(id: string): Promise<void> {
    const it = this.item(id);
    const runId = this.state.runId;
    if (!it || !it.canDraft || !runId || it.drafting) return;
    this.updateItem(id, { drafting: true, note: undefined });
    const field = this.fields.get(id);
    const res = await this.deps.api({
      op: 'answer',
      body: {
        runId,
        question: it.label.slice(0, 2000),
        fieldType: answerFieldType(it.kind),
        maxLength: field?.maxLength,
        options: field?.options?.slice(0, 100),
      },
      idempotencyKey: newIdempotencyKey(),
    });
    if (!res.ok) {
      if (res.code === 'ai_unavailable' || res.code === 'feature_disabled') {
        this.aiAvailable = false;
        this.set({ items: this.state.items.map((x) => ({ ...x, canDraft: false, drafting: false, note: x.id === id ? 'ai_unavailable' : x.note })) });
      } else if (errorReason(res) === EXTENSION_ERROR_CODES.protectedQuestion) {
        // The server classed it as protected (legal, pay, EEO, grades …): never drafted.
        this.updateItem(id, { drafting: false, canDraft: false, note: 'protected', protectedType: protectedTypeIn(res.details) ?? it.protectedType });
      } else if (res.code === 'credits_exhausted') {
        const details = res.details as { resetsAt?: string } | undefined;
        this.updateItem(id, { drafting: false, note: 'draft_failed' });
        this.set({ error: 'credits_exhausted', resetsAt: typeof details?.resetsAt === 'string' ? details.resetsAt : null });
      } else {
        this.updateItem(id, { drafting: false, note: 'draft_failed' });
      }
      return;
    }
    const { answer, source, saveable } = res.data;
    if (!answer || source === 'none') {
      // Older servers answer a protected question with `reason: 'protected'` instead of refusing it.
      if (res.data.reason === 'protected') this.updateItem(id, { drafting: false, canDraft: false, note: 'protected' });
      else this.updateItem(id, { drafting: false, note: 'no_value' });
      return;
    }
    this.updateItem(id, { drafting: false, draft: { text: answer, source, saveable } });
  }

  /** The user's explicit "Use this answer" for one field (with their edits). */
  async useDraft(id: string, text?: string): Promise<boolean> {
    const it = this.item(id);
    if (!it?.draft) return false;
    const value = (text ?? it.draft.text).trim();
    if (!value) return false;
    const source: ItemSource = it.draft.source === 'ai' ? 'ai' : 'bank';
    const saveable = it.draft.saveable && !it.protectedType;
    this.approvals.add(id);
    const res = await this.apply(id, { kind: 'text', text: value }, source);
    this.approvals.delete(id);
    if (res.ok) this.updateItem(id, { status: 'filled', source, draft: undefined, note: undefined, savable: saveable ? { text: value } : undefined, saved: false, saveError: undefined });
    else this.updateItem(id, { note: noteFor(res.reason) });
    return res.ok;
  }

  /**
   * "Save this answer": the answer the user just used goes to their saved
   * answers, so the next form with this question is filled from them. Only
   * on the user's click, and never for a protected question.
   */
  async saveDraftAnswer(id: string): Promise<boolean> {
    const it = this.item(id);
    const runId = this.state.runId;
    if (!it?.savable || it.saving || it.saved || !runId || it.protectedType) return false;
    this.updateItem(id, { saving: true, saveError: undefined });
    const res = await this.deps.api({ op: 'saveAnswer', body: { runId, question: it.label.slice(0, 500), answer: it.savable.text.slice(0, 5000) } });
    if (res.ok) {
      this.updateItem(id, { saving: false, saved: true });
      return true;
    }
    const refused = errorReason(res) === EXTENSION_ERROR_CODES.protectedQuestion;
    this.updateItem(id, { saving: false, saveError: refused ? 'protected' : 'failed', ...(refused ? { savable: undefined, protectedType: protectedTypeIn(res.details) ?? it.protectedType } : {}) });
    return false;
  }

  dismissDraft(id: string): void {
    this.updateItem(id, { draft: undefined });
  }

  /** "Undo autofill": restore every field we changed, newest first. */
  undo(): { restored: number; notRestored: number } {
    let restored = 0;
    let notRestored = 0;
    const touched = new Set<string>();
    for (const entry of [...this.log].reverse()) {
      const field = this.fields.get(entry.id);
      if (field && restoreField(field, entry.previous)) restored++;
      else notRestored++;
      touched.add(entry.id);
    }
    this.log = [];
    const result = { restored, notRestored };
    this.set({
      undo: result,
      items: this.state.items.map((it) =>
        touched.has(it.id) ? { ...it, status: it.required ? 'needs_you' : 'skipped', source: undefined, fileName: undefined, note: 'undone', savable: undefined } : it,
      ),
    });
    return result;
  }

  /** "Did you submit this application?" — the user's answer is the only signal (D1). */
  async markSubmitted(submitted: boolean): Promise<boolean> {
    if (!submitted) {
      this.set({ submitted: 'not_yet' });
      return true;
    }
    const runId = this.state.runId;
    if (!runId) return false;
    const res = await this.deps.api({
      op: 'patchRun',
      id: runId,
      body: { ...this.totals(), outcome: this.outcome(), userMarkedSubmitted: true },
    });
    if (res.ok) this.set({ submitted: 'yes' });
    return res.ok;
  }
}

/** The protected type a `protected_question` refusal names (`details.type`), when it is one we know. */
function protectedTypeIn(details: unknown): ProtectedQuestionType | undefined {
  const d = details as { type?: unknown; protectedType?: unknown } | null | undefined;
  return [d?.type, d?.protectedType].find((t): t is ProtectedQuestionType => (PROTECTED_QUESTION_TYPES as readonly unknown[]).includes(t));
}

/** Why a portal field the cn map owns was left for the user. */
function cnNote(cn: CnPlanEntry, it: ChecklistItem, profile: AutofillProfile): ItemNote {
  if (cn.leave) return cn.leave;
  if (cn.personal) return 'personal';
  // The optional details exist only with the consent: without it, say so instead of "add them".
  if (cn.key && CN_SENSITIVE_STORE_KEYS.has(cn.key) && profile.sensitive === null) return 'sensitive_consent';
  if (cn.section === 'family' && cn.key) return 'family_none';
  return it.protectedType ? 'protected' : 'no_value';
}

/** Does the form already hold something in this field? (`blank` mode leaves such fields alone.) */
export function hasValue(field: FieldHandle): boolean {
  const el = field.element as HTMLInputElement;
  switch (field.kind) {
    case 'radio':
      return (field.group ?? [el]).some((r) => r.checked);
    case 'checkbox':
      return el.checked;
    case 'file':
      return (el.files?.length ?? 0) > 0;
    case 'select': {
      const select = field.element as HTMLSelectElement;
      const opt = select.selectedOptions?.[0];
      return Boolean(select.value) && !(opt && isPlaceholderOption(opt.textContent ?? '', opt.value));
    }
    case 'combobox': {
      if ((el.value ?? '').trim()) return true;
      // Custom selects show the chosen option beside an empty search input.
      let box: Element | null = el.parentElement;
      for (let level = 0; box && level < 4; level++, box = box.parentElement) {
        const shown = box.querySelector('[class*="selection-item"], [class*="selected-value"], [class*="select__value"]');
        if (shown) return Boolean((shown.textContent ?? '').trim());
      }
      return false;
    }
    default:
      return Boolean((el.value ?? '').trim());
  }
}

export function summarize(items: readonly ChecklistItem[]): { filled: number; needsYou: number; skipped: number; total: number } {
  return {
    filled: items.filter((i) => i.status === 'filled').length,
    needsYou: items.filter((i) => i.status === 'needs_you').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    total: items.length,
  };
}
