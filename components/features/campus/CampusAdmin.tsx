'use client';

// CampusAdmin — /admin/campus: 校招日历 curation (WP-58). Admin only; the API
// enforces it too.
//
//   Start from an official page  paste the employer's own URL → the server
//                                reads that one page → the AI model suggests
//                                fields, each with the sentence it rests on
//                                (AI label) → staff check and save a DRAFT.
//                                The model is GoApply's own when one is set
//                                (CN_LLM_*), otherwise the shared one (D5), so
//                                reading a page works with no CN model; it is
//                                refused (503 ai_unavailable) only when AI is
//                                off on the server. "Fill in by hand" skips
//                                the model.
//   Entries by status            Drafts / Published / Archived. Each entry:
//                                "I checked it against the official page"
//                                (verifiedAt + verifiedBy), then Publish
//                                (disabled until checked), Edit (a changed fact
//                                clears the check), Archive / Delete draft.
// Aggregator and job-board URLs are refused by the server; the reason shows.

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { EmptyState } from '../../v3/primitives/EmptyState';
import { PageHeader } from '../../v3/primitives/PageHeader';
import { Tabs, tabPanelProps } from '../../v3/primitives/Tabs';
import { Tag } from '../../v3/primitives/Tag';
import { AiGeneratedBadge } from '../market';
import { useAuth } from '../../../lib/auth/useAuth';
import { apiErrorCode, apiErrorReason } from '../../../lib/api/contracts/wire';
import type { AdminCampusEventView, CampusEventDraft, CampusExtractResponse } from '../../../lib/api/campus';
import { useCampusDates } from './EventCard';
import { CLASS_YEARS, EVENT_KINDS, STAGE_KINDS, fromBeijingLocal, safeExternal, splitList, toBeijingLocal } from './format';
import {
  useAdminCampusEvents,
  useCreateCampusEvent,
  useDeleteCampusEvent,
  useExtractCampusEvent,
  usePublishCampusEvent,
  useUpdateCampusEvent,
  useVerifyCampusEvent,
} from './useCampus';
import styles from './campus.module.css';

type Status = 'draft' | 'published' | 'archived';
const STATUSES: readonly Status[] = ['draft', 'published', 'archived'];
const KNOWN_ERRORS = [
  'aggregator_source',
  'not_a_web_address',
  'page_unreachable',
  'extract_failed',
  'ai_unavailable',
  'apply_window_inverted',
  'campus_event_not_verified',
] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];
const isKnown = (v: string | null | undefined): v is KnownError => !!v && (KNOWN_ERRORS as readonly string[]).includes(v);

/**
 * The localized message key for a failed admin call: the specific reason when
 * known, else the error code. `ai_unavailable` (with any reason this page does
 * not know, such as the older `no_model`) reads "AI is off on this server".
 */
export function errorKey(err: unknown): KnownError | 'generic' {
  const reason = apiErrorReason(err);
  if (isKnown(reason)) return reason;
  const code = apiErrorCode(err);
  return isKnown(code) ? code : 'generic';
}

export function CampusAdmin() {
  const t = useTranslations('campus.admin');
  const tAdmin = useTranslations('admin');
  const { user, status } = useAuth();
  const [editing, setEditing] = useState<{ initial: FormState; id: string | null; extract: CampusExtractResponse | null } | null>(null);

  if (status === 'loading') {
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  }
  if (user?.role !== 'admin') {
    return <EmptyState title={`${tAdmin('notAuthorized.title')} ${tAdmin('notAuthorized.titleAccent')}`} sub={t('notAdmin')} />;
  }
  return (
    <div className={styles.page} data-testid="admin-campus">
      <PageHeader title={t('title')} sub={t('sub')} />
      {editing ? (
        <EventForm key={editing.id ?? 'new'} id={editing.id} initial={editing.initial} extract={editing.extract} onDone={() => setEditing(null)} />
      ) : (
        <ExtractPanel onDraft={(initial, extract) => setEditing({ initial, id: null, extract })} />
      )}
      <EntryList onEdit={(ev) => setEditing({ initial: formFromView(ev), id: ev.id, extract: null })} />
    </div>
  );
}

// ── Start from an official page ──

function ExtractPanel({ onDraft }: { onDraft: (initial: FormState, extract: CampusExtractResponse | null) => void }) {
  const t = useTranslations('campus.admin');
  const [url, setUrl] = useState('');
  const extract = useExtractCampusEvent();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    extract.mutate(url.trim(), { onSuccess: (res) => onDraft(formFromDraft(res.draft), res) });
  };
  return (
    <section className={styles.box} aria-labelledby="campus-extract-h">
      <h2 className={styles.h2} id="campus-extract-h">
        {t('extract.title')}
      </h2>
      <p className={styles.body}>{t('extract.sub')}</p>
      <form className={styles.row} onSubmit={submit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-extract-url">
            {t('extract.url')}
          </label>
          <input
            id="campus-extract-url"
            className={styles.input}
            type="url"
            inputMode="url"
            value={url}
            maxLength={2000}
            placeholder={t('extract.urlPlaceholder')}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <Btn type="submit" variant="primary" disabled={extract.isPending || !url.trim()}>
          {extract.isPending ? t('extract.reading') : t('extract.button')}
        </Btn>
        <Btn type="button" onClick={() => onDraft({ ...EMPTY_FORM, officialUrl: url.trim() }, null)}>
          {t('extract.manual')}
        </Btn>
      </form>
      {extract.isError ? (
        <p className={styles.error} role="alert">
          {t(`errors.${errorKey(extract.error)}`)}
        </p>
      ) : null}
    </section>
  );
}

// ── Form ──

interface StageForm {
  kind: (typeof STAGE_KINDS)[number];
  start: string;
  end: string;
  note: string;
}

export interface FormState {
  companyName: string;
  title: string;
  year: number;
  kind: (typeof EVENT_KINDS)[number];
  opens: string;
  closes: string;
  cities: string;
  roles: string;
  officialUrl: string;
  sourceName: string;
  sourceUrl: string;
  sourceNote: string;
  stages: StageForm[];
}

const EMPTY_FORM: FormState = {
  companyName: '',
  title: '',
  year: CLASS_YEARS[2],
  kind: 'application',
  opens: '',
  closes: '',
  cities: '',
  roles: '',
  officialUrl: '',
  sourceName: '',
  sourceUrl: '',
  sourceNote: '',
  stages: [],
};

const yearOf = (cls: string | undefined | null) => {
  const m = /^(20\d\d)届$/.exec(cls ?? '');
  return m ? Number(m[1]) : CLASS_YEARS[2];
};

export function formFromDraft(d: Partial<CampusEventDraft> & { officialUrl: string }): FormState {
  return {
    ...EMPTY_FORM,
    companyName: d.companyName ?? '',
    title: d.title ?? '',
    year: yearOf(d.graduationClass),
    kind: d.kind ?? 'application',
    opens: toBeijingLocal(d.applyOpensAt),
    closes: toBeijingLocal(d.applyClosesAt),
    cities: (d.cities ?? []).join('、'),
    roles: (d.roles ?? []).join('、'),
    officialUrl: d.officialUrl,
    sourceName: d.sourceName ?? '',
    sourceUrl: d.sourceUrl ?? '',
    stages: (d.stages ?? []).map((s) => ({ kind: s.kind, start: toBeijingLocal(s.startsAt), end: toBeijingLocal(s.endsAt), note: s.note ?? '' })),
  };
}

function formFromView(v: AdminCampusEventView): FormState {
  return {
    ...formFromDraft({
      companyName: v.companyName,
      title: v.title,
      graduationClass: v.graduationClass,
      kind: v.kind,
      stages: v.stages,
      cities: v.cities,
      roles: v.roles,
      officialUrl: v.officialUrl,
      ...(v.applyOpensAt ? { applyOpensAt: v.applyOpensAt } : {}),
      ...(v.applyClosesAt ? { applyClosesAt: v.applyClosesAt } : {}),
      ...(v.sourceUrl ? { sourceUrl: v.sourceUrl } : {}),
      ...(v.sourceName ? { sourceName: v.sourceName } : {}),
    }),
    sourceNote: v.sourceNote ?? '',
  };
}

/** Form → the draft body (dates read as Beijing time). */
export function bodyFromForm(f: FormState): CampusEventDraft {
  const opens = fromBeijingLocal(f.opens);
  const closes = fromBeijingLocal(f.closes);
  return {
    companyName: f.companyName.trim(),
    title: f.title.trim(),
    graduationClass: `${f.year}届`,
    kind: f.kind,
    ...(opens ? { applyOpensAt: opens } : {}),
    ...(closes ? { applyClosesAt: closes } : {}),
    stages: f.stages.map((s) => {
      const startsAt = fromBeijingLocal(s.start);
      const endsAt = fromBeijingLocal(s.end);
      return { kind: s.kind, ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}), ...(s.note.trim() ? { note: s.note.trim() } : {}) };
    }),
    cities: splitList(f.cities),
    roles: splitList(f.roles),
    officialUrl: f.officialUrl.trim(),
    ...(f.sourceUrl.trim() ? { sourceUrl: f.sourceUrl.trim() } : {}),
    ...(f.sourceName.trim() ? { sourceName: f.sourceName.trim() } : {}),
    ...(f.sourceNote.trim() ? { sourceNote: f.sourceNote.trim() } : {}),
  };
}

function EventForm({ id, initial, extract, onDone }: { id: string | null; initial: FormState; extract: CampusExtractResponse | null; onDone: () => void }) {
  const t = useTranslations('campus.admin');
  const tf = useTranslations('campus.admin.form');
  const te = useTranslations('campus.event');
  const tc = useTranslations('campus.filters');
  const [f, setF] = useState<FormState>(initial);
  const create = useCreateCampusEvent();
  const update = useUpdateCampusEvent();
  const saving = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const ev = extract?.evidence ?? {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = bodyFromForm(f);
    if (id) {
      // An emptied date or source field is sent as null, which clears it.
      update.mutate(
        {
          id,
          body: {
            ...body,
            applyOpensAt: body.applyOpensAt ?? null,
            applyClosesAt: body.applyClosesAt ?? null,
            sourceUrl: body.sourceUrl ?? null,
            sourceName: body.sourceName ?? null,
            sourceNote: body.sourceNote ?? null,
          },
        },
        { onSuccess: onDone },
      );
    } else create.mutate(body, { onSuccess: onDone });
  };

  const quote = (field: keyof CampusExtractResponse['evidence']) =>
    ev[field] ? <p className={styles.evidence}>{t('extract.evidence', { quote: ev[field]! })}</p> : null;

  const text = (key: 'companyName' | 'title' | 'officialUrl' | 'sourceName' | 'sourceUrl', opts: { required?: boolean; type?: string; max: number; evidence?: keyof CampusExtractResponse['evidence'] }) => (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={`campus-f-${key}`}>
        {tf(key)}
      </label>
      <input
        id={`campus-f-${key}`}
        className={styles.input}
        type={opts.type ?? 'text'}
        required={opts.required}
        maxLength={opts.max}
        value={f[key]}
        onChange={(e) => set(key, e.target.value)}
      />
      {opts.evidence ? quote(opts.evidence) : null}
    </div>
  );

  return (
    <section className={styles.box} aria-labelledby="campus-form-h">
      <h2 className={styles.h2} id="campus-form-h">
        {id ? tf('titleEdit') : tf('titleNew')}
      </h2>
      {extract ? (
        <>
          <p className={styles.aiNote}>
            <AiGeneratedBadge />
            <span>{t('extract.aiNote')}</span>
          </p>
          <p className={styles.muted}>{t('extract.fromPage', { url: extract.finalUrl })}</p>
          {extract.dropped.length ? <p className={styles.muted}>{t('extract.dropped', { fields: extract.dropped.map((d) => tf(d)).join('、') })}</p> : null}
        </>
      ) : null}
      {id ? <p className={styles.muted}>{tf('editClearsCheck')}</p> : null}

      <form className={styles.formGrid} onSubmit={submit}>
        {text('companyName', { required: true, max: 200, evidence: 'companyName' })}
        {text('title', { required: true, max: 200, evidence: 'title' })}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-f-class">
            {tf('graduationClass')}
          </label>
          <select id="campus-f-class" className={styles.select} value={f.year} onChange={(e) => set('year', Number(e.target.value))}>
            {CLASS_YEARS.map((y) => (
              <option key={y} value={y}>
                {tc('classOption', { year: y })}
              </option>
            ))}
          </select>
          {quote('graduationClass')}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-f-kind">
            {tf('kind')}
          </label>
          <select id="campus-f-kind" className={styles.select} value={f.kind} onChange={(e) => set('kind', e.target.value as FormState['kind'])}>
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {te(`kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-f-opens">
            {tf('applyOpensAt')}
          </label>
          <input id="campus-f-opens" className={styles.input} type="datetime-local" value={f.opens} onChange={(e) => set('opens', e.target.value)} />
          {quote('applyOpensAt')}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-f-closes">
            {tf('applyClosesAt')}
          </label>
          <input id="campus-f-closes" className={styles.input} type="datetime-local" value={f.closes} onChange={(e) => set('closes', e.target.value)} />
          {quote('applyClosesAt')}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-f-cities">
            {tf('cities')}
          </label>
          <input id="campus-f-cities" className={styles.input} value={f.cities} placeholder={tf('listHint')} onChange={(e) => set('cities', e.target.value)} />
          {quote('cities')}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-f-roles">
            {tf('roles')}
          </label>
          <input id="campus-f-roles" className={styles.input} value={f.roles} placeholder={tf('listHint')} onChange={(e) => set('roles', e.target.value)} />
          {quote('roles')}
        </div>
        {text('officialUrl', { required: true, type: 'url', max: 2000 })}
        {text('sourceName', { max: 120 })}
        {text('sourceUrl', { type: 'url', max: 2000 })}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="campus-f-note">
            {tf('sourceNote')}
          </label>
          <input id="campus-f-note" className={styles.input} maxLength={500} value={f.sourceNote} onChange={(e) => set('sourceNote', e.target.value)} />
        </div>

        <fieldset className={`${styles.wide} ${styles.box}`}>
          <legend className={styles.label}>{tf('stages')}</legend>
          {quote('stages')}
          {f.stages.map((s, i) => (
            <div className={styles.stageRow} key={i}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`campus-s-${i}-kind`}>
                  {tf('stageKind')}
                </label>
                <select
                  id={`campus-s-${i}-kind`}
                  className={styles.select}
                  value={s.kind}
                  onChange={(e) => set('stages', f.stages.map((x, j) => (j === i ? { ...x, kind: e.target.value as StageForm['kind'] } : x)))}
                >
                  {STAGE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {te(`stage.${k}`)}
                    </option>
                  ))}
                </select>
              </div>
              {(['start', 'end'] as const).map((k) => (
                <div className={styles.field} key={k}>
                  <label className={styles.label} htmlFor={`campus-s-${i}-${k}`}>
                    {tf(k === 'start' ? 'stageStart' : 'stageEnd')}
                  </label>
                  <input
                    id={`campus-s-${i}-${k}`}
                    className={styles.input}
                    type="datetime-local"
                    value={s[k]}
                    onChange={(e) => set('stages', f.stages.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                  />
                </div>
              ))}
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`campus-s-${i}-note`}>
                  {tf('stageNote')}
                </label>
                <input
                  id={`campus-s-${i}-note`}
                  className={styles.input}
                  maxLength={300}
                  value={s.note}
                  onChange={(e) => set('stages', f.stages.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                />
              </div>
              <Btn type="button" variant="ghost" onClick={() => set('stages', f.stages.filter((_, j) => j !== i))}>
                {tf('removeStage')}
              </Btn>
            </div>
          ))}
          <div>
            <Btn type="button" onClick={() => set('stages', [...f.stages, { kind: 'bishi', start: '', end: '', note: '' }])} disabled={f.stages.length >= 20}>
              {tf('addStage')}
            </Btn>
          </div>
        </fieldset>

        <div className={`${styles.wide} ${styles.actions}`}>
          <Btn type="submit" variant="primary" disabled={saving}>
            {saving ? tf('saving') : id ? tf('saveEdit') : tf('save')}
          </Btn>
          <Btn type="button" onClick={onDone} disabled={saving}>
            {tf('cancel')}
          </Btn>
        </div>
        {error ? (
          <p className={`${styles.wide} ${styles.error}`} role="alert">
            {t(`errors.${errorKey(error)}`)}
          </p>
        ) : null}
      </form>
    </section>
  );
}

// ── Entries ──

function EntryList({ onEdit }: { onEdit: (ev: AdminCampusEventView) => void }) {
  const t = useTranslations('campus.admin');
  const [tab, setTab] = useState<Status>('draft');
  const q = useAdminCampusEvents(tab);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className={styles.box} aria-label={t('tabs.label')}>
      <Tabs tabs={STATUSES.map((s) => ({ id: s, label: t(`tabs.${s}`) }))} value={tab} onChange={setTab} ariaLabel={t('tabs.label')} idBase="campus-admin" />
      <div {...tabPanelProps('campus-admin', tab)} className={styles.cardHead}>
        {q.isLoading ? (
          <p className={styles.muted}>{t('loading')}</p>
        ) : q.isError ? (
          <p className={styles.error} role="alert">
            {t('errors.generic')}
          </p>
        ) : !items.length ? (
          <p className={styles.muted}>{t(`empty.${tab}`)}</p>
        ) : (
          <ul className={styles.adminItems}>
            {items.map((ev) => (
              <li key={ev.id}>
                <AdminItem ev={ev} onEdit={() => onEdit(ev)} />
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage ? (
          <div className={styles.more}>
            <Btn onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {t('more')}
            </Btn>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AdminItem({ ev, onEdit }: { ev: AdminCampusEventView; onEdit: () => void }) {
  const t = useTranslations('campus.admin');
  const te = useTranslations('campus.event');
  const dates = useCampusDates();
  const verify = useVerifyCampusEvent();
  const publish = usePublishCampusEvent();
  const remove = useDeleteCampusEvent();
  // Archive (cannot be published again) and delete (gone) both ask once more, inline.
  const [confirming, setConfirming] = useState(false);
  const deletes = ev.status === 'draft' && !ev.verifiedAt;
  const busy = verify.isPending || publish.isPending || remove.isPending;
  const error = verify.error ?? publish.error ?? remove.error;
  const official = safeExternal(ev.officialUrl);
  const checked = ev.verifiedAt ? (ev.verifiedByName ? t('item.checkedBy', { date: dates.day(ev.verifiedAt) ?? '—', name: ev.verifiedByName }) : t('item.checkedAt', { date: dates.day(ev.verifiedAt) ?? '—' })) : t('item.notChecked');
  const closes = dates.moment(ev.applyClosesAt);

  return (
    <article className={styles.adminItem} aria-labelledby={`campus-admin-${ev.id}`} data-campus-admin-item={ev.id}>
      <h3 className={styles.h3} id={`campus-admin-${ev.id}`}>
        {ev.companyName} · {ev.title}
      </h3>
      <div className={styles.tags}>
        <Tag>{ev.graduationClass}</Tag>
        <Tag tone={ev.verifiedAt ? 'default' : 'warn'}>{checked}</Tag>
        {ev.status === 'published' && ev.needsReverify ? <Tag tone="warn">{te('needsCheck')}</Tag> : null}
      </div>
      <p className={styles.body}>{closes ? te('closes', { date: closes }) : te('noClose')}</p>
      <p className={styles.muted}>
        {te('source', { source: ev.sourceName ?? '—' })}
        {official ? (
          <>
            {' · '}
            <a className={styles.link} href={official} target="_blank" rel="noopener noreferrer">
              {official}
            </a>
          </>
        ) : null}
      </p>
      {ev.status !== 'archived' ? (
        <div className={styles.actions}>
          <Btn onClick={onEdit} disabled={busy}>
            {t('item.edit')}
          </Btn>
          <Btn onClick={() => verify.mutate(ev.id)} disabled={busy}>
            {busy && verify.isPending ? t('item.working') : ev.verifiedAt ? t('item.verifyAgain') : t('item.verify')}
          </Btn>
          {ev.status === 'draft' ? (
            <Btn variant="primary" onClick={() => publish.mutate(ev.id)} disabled={busy || !ev.verifiedAt}>
              {t('item.publish')}
            </Btn>
          ) : null}
          {confirming ? null : (
            <Btn variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
              {deletes ? t('item.delete') : t('item.archive')}
            </Btn>
          )}
        </div>
      ) : null}
      {ev.status !== 'archived' && confirming ? (
        <div className={styles.confirm} role="group" aria-labelledby={`campus-admin-confirm-${ev.id}`} data-campus-confirm={ev.id}>
          <p className={styles.body} id={`campus-admin-confirm-${ev.id}`}>
            {deletes ? t('item.confirmDelete') : t('item.confirmArchive')}
          </p>
          <div className={styles.actions}>
            <Btn variant="primary" onClick={() => remove.mutate(ev.id, { onSettled: () => setConfirming(false) })} disabled={busy}>
              {busy && remove.isPending ? t('item.working') : deletes ? t('item.confirmDeleteYes') : t('item.confirmArchiveYes')}
            </Btn>
            <Btn variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              {t('item.cancel')}
            </Btn>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {t(`errors.${errorKey(error)}`)}
        </p>
      ) : null}
    </article>
  );
}
