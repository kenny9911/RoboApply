'use client';

// AnnouncementsAdmin — /admin/announcements: "What's new" notes per site,
// language and audience (F-NOTIF-09; WP-61). Admin only; the API enforces it.
//
//   List      every announcement with its site, status (Draft / Scheduled /
//             Live / Ended), window and how many languages are still missing;
//             Edit, Publish / Unpublish, Delete.
//   Editor    key (new only), site (new only), the languages it shows in, the
//             window, order, audience (plans, signed up before, feature
//             switches) and the text for EVERY language the site offers.
//             "Translated before publish": publishing is disabled until every
//             site language has a title and a message (the server checks too).

import { useMemo, useState, type FormEvent } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../../../components/v3/primitives/Btn';
import { EmptyState } from '../../../../components/v3/primitives/EmptyState';
import { Modal } from '../../../../components/v3/primitives/Modal';
import { PageHeader } from '../../../../components/v3/primitives/PageHeader';
import { Pill, type PillTone } from '../../../../components/v3/primitives/Pill';
import { toast } from '../../../../components/v3/primitives/Toast';
import { BRAND_IDS, getBrand, type BrandId } from '../../../../lib/brand';
import { useAuth } from '../../../../lib/auth/useAuth';
import { apiErrorDetails, apiErrorReason } from '../../../../lib/api/contracts/wire';
import {
  useAdminAnnouncements,
  useCreateAnnouncement,
  useDeleteAnnouncement,
  useUpdateAnnouncement,
  type AdminAnnouncementView,
  type PatchAnnouncementInput,
  type UpsertAnnouncementInput,
} from '../../../../hooks/pwa';
import styles from './announcements.module.css';

const STATUS_TONE: Record<AdminAnnouncementView['status'], PillTone> = {
  draft: 'muted',
  scheduled: 'violet',
  live: 'ok',
  ended: 'muted',
};

const KNOWN_ERRORS = ['translations_missing', 'locale_not_served', 'key_taken', 'invalid_window', 'unknown_flag'] as const;

// ── Helpers ──────────────────────────────────────────────────────────────

export function useLanguageName(): (code: string) => string {
  const ui = useLocale();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([ui], { type: 'language' });
    } catch {
      names = null;
    }
    return (code: string) => {
      try {
        return names?.of(code) ?? code;
      } catch {
        return code;
      }
    };
  }, [ui]);
}

/** ISO → the value a `datetime-local` input shows (local time), or ''. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` / `date` value (local time) → ISO, or undefined when empty/invalid. */
export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface LocaleText {
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}

export interface AnnouncementFormState {
  key: string;
  brand: BrandId;
  locales: string[];
  startsAt: string;
  endsAt: string;
  priority: string;
  plans: string;
  signedUpBefore: string;
  flags: string;
  content: Record<string, LocaleText>;
}

const EMPTY_TEXT: LocaleText = { title: '', body: '', ctaLabel: '', ctaHref: '' };

export function emptyForm(brand: BrandId): AnnouncementFormState {
  return {
    key: '',
    brand,
    locales: [...getBrand(brand).locales],
    startsAt: '',
    endsAt: '',
    priority: '',
    plans: '',
    signedUpBefore: '',
    flags: '',
    content: {},
  };
}

export function formFromView(v: AdminAnnouncementView): AnnouncementFormState {
  const content: Record<string, LocaleText> = {};
  for (const [locale, c] of Object.entries(v.content)) {
    content[locale] = { title: c.title, body: c.body, ctaLabel: c.ctaLabel ?? '', ctaHref: c.ctaHref ?? '' };
  }
  return {
    key: v.key,
    brand: v.brand,
    locales: [...v.locales],
    startsAt: toLocalInput(v.startsAt),
    endsAt: toLocalInput(v.endsAt),
    priority: String(v.priority),
    plans: (v.cohort.plans ?? []).join(', '),
    signedUpBefore: v.cohort.signedUpBefore ? v.cohort.signedUpBefore.slice(0, 10) : '',
    flags: (v.cohort.flags ?? []).join(', '),
    content,
  };
}

/** Languages with a title AND a message; and those with only one of them. */
export function contentStatus(form: AnnouncementFormState): { complete: string[]; partial: string[]; missing: string[] } {
  const complete: string[] = [];
  const partial: string[] = [];
  const missing: string[] = [];
  for (const locale of getBrand(form.brand).locales) {
    const c = form.content[locale] ?? EMPTY_TEXT;
    const title = c.title.trim();
    const body = c.body.trim();
    if (title && body) complete.push(locale);
    else if (title || body || c.ctaLabel.trim() || c.ctaHref.trim()) partial.push(locale);
    else missing.push(locale);
  }
  return { complete, partial, missing };
}

/** The request body parts shared by create and update. */
export function formPayload(form: AnnouncementFormState) {
  const { complete } = contentStatus(form);
  const content: UpsertAnnouncementInput['content'] = {};
  for (const locale of complete) {
    const c = form.content[locale]!;
    content[locale] = {
      title: c.title.trim(),
      body: c.body.trim(),
      ...(c.ctaLabel.trim() ? { ctaLabel: c.ctaLabel.trim() } : {}),
      ...(c.ctaHref.trim() ? { ctaHref: c.ctaHref.trim() } : {}),
    };
  }
  const plans = splitList(form.plans);
  const flags = splitList(form.flags);
  const signedUpBefore = fromLocalInput(form.signedUpBefore ? `${form.signedUpBefore}T00:00` : '');
  const priority = form.priority.trim() === '' ? undefined : Number(form.priority);
  return {
    locales: form.locales,
    content,
    cohort: {
      ...(plans.length ? { plans } : {}),
      ...(signedUpBefore ? { signedUpBefore } : {}),
      ...(flags.length ? { flags } : {}),
    },
    startsAt: fromLocalInput(form.startsAt),
    endsAt: fromLocalInput(form.endsAt),
    priority: priority !== undefined && Number.isFinite(priority) ? Math.max(0, Math.min(1000, Math.round(priority))) : undefined,
  };
}

// ── Page ─────────────────────────────────────────────────────────────────

export function AnnouncementsAdmin() {
  const t = useTranslations('pwa.admin');
  const { user, status } = useAuth();
  if (status === 'loading') {
    return (
      <p className={styles.muted} aria-busy="true">
        {t('loading')}
      </p>
    );
  }
  if (user?.role !== 'admin') return <EmptyState title={t('title')} sub={t('notAuthorized')} />;
  return <AdminConsole />;
}

type Editing = { mode: 'create' } | { mode: 'edit'; item: AdminAnnouncementView } | null;

function AdminConsole() {
  const t = useTranslations('pwa.admin');
  const [brand, setBrand] = useState<BrandId | 'all'>('all');
  const list = useAdminAnnouncements(brand === 'all' ? {} : { brand });
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<AdminAnnouncementView | null>(null);

  return (
    <div className={styles.page} data-testid="admin-announcements">
      <PageHeader
        title={t('title')}
        sub={t('sub')}
        actions={
          <Btn variant="primary" onClick={() => setEditing({ mode: 'create' })}>
            {t('new')}
          </Btn>
        }
      />
      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('brandFilter')}</span>
          <select className={styles.input} value={brand} onChange={(e) => setBrand(e.target.value as BrandId | 'all')}>
            <option value="all">{t('allBrands')}</option>
            {BRAND_IDS.map((id) => (
              <option key={id} value={id}>
                {getBrand(id).name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {list.isLoading ? (
        <p className={styles.muted} aria-busy="true">
          {t('loading')}
        </p>
      ) : list.isError ? (
        <EmptyState
          title={t('loadFailed')}
          action={
            <Btn onClick={() => void list.refetch()}>
              {t('retry')}
            </Btn>
          }
        />
      ) : !list.data?.items.length ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className={styles.list}>
          {list.data.items.map((item) => (
            <Row key={item.id} item={item} onEdit={() => setEditing({ mode: 'edit', item })} onDelete={() => setDeleting(item)} />
          ))}
        </ul>
      )}

      {editing ? <Editor editing={editing} defaultBrand={brand === 'all' ? 'roboapply' : brand} onClose={() => setEditing(null)} /> : null}
      {deleting ? <ConfirmDelete item={deleting} onClose={() => setDeleting(null)} /> : null}
    </div>
  );
}

function Row({ item, onEdit, onDelete }: { item: AdminAnnouncementView; onEdit: () => void; onDelete: () => void }) {
  const t = useTranslations('pwa.admin');
  const format = useFormatter();
  const update = useUpdateAnnouncement();
  const date = (iso: string) => format.dateTime(new Date(iso), { year: 'numeric', month: 'short', day: 'numeric' });
  const canPublish = item.missingLocales.length === 0;

  const toggle = () =>
    update.mutate(
      { id: item.id, body: { active: !item.active } },
      {
        onSuccess: (v) => toast({ message: v.active ? t('published') : t('unpublished'), tone: 'ok' }),
        onError: () => toast({ message: t('saveFailed'), tone: 'danger' }),
      },
    );

  return (
    <li className={styles.row} data-testid={`announcement-${item.key}`}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          <span className={styles.key}>{item.key}</span>
          <Pill tone={STATUS_TONE[item.status]}>{t(`status.${item.status}`)}</Pill>
        </div>
        <p className={styles.muted}>
          {getBrand(item.brand).name} · {t('window', { start: date(item.startsAt), end: date(item.endsAt) })} ·{' '}
          {canPublish ? t('allTranslated') : t('missingCount', { count: item.missingLocales.length })}
        </p>
      </div>
      <div className={styles.rowActions}>
        <Btn variant="ghost" onClick={onEdit}>
          {t('edit')}
        </Btn>
        {item.active ? (
          <Btn variant="ghost" onClick={toggle} disabled={update.isPending}>
            {t('unpublish')}
          </Btn>
        ) : (
          <Btn variant="ghost" onClick={toggle} disabled={update.isPending || !canPublish} title={canPublish ? undefined : t('missingCount', { count: item.missingLocales.length })}>
            {t('publish')}
          </Btn>
        )}
        <Btn variant="ghost" onClick={onDelete}>
          {t('delete')}
        </Btn>
      </div>
    </li>
  );
}

function ConfirmDelete({ item, onClose }: { item: AdminAnnouncementView; onClose: () => void }) {
  const t = useTranslations('pwa.admin');
  const del = useDeleteAnnouncement();
  return (
    <Modal
      open
      onClose={onClose}
      title={t('delete')}
      maxWidth="sm"
      footer={
        <div className={styles.footer}>
          <Btn variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Btn>
          <Btn
            variant="primary"
            disabled={del.isPending}
            onClick={() =>
              del.mutate(item.id, {
                onSuccess: () => {
                  toast({ message: t('deleted'), tone: 'ok' });
                  onClose();
                },
                onError: () => toast({ message: t('saveFailed'), tone: 'danger' }),
              })
            }
          >
            {t('confirmDeleteYes')}
          </Btn>
        </div>
      }
    >
      <p className={styles.text}>{t('confirmDelete', { key: item.key })}</p>
    </Modal>
  );
}

// ── Editor ───────────────────────────────────────────────────────────────

function Editor({ editing, defaultBrand, onClose }: { editing: NonNullable<Editing>; defaultBrand: BrandId; onClose: () => void }) {
  const t = useTranslations('pwa.admin');
  const tf = useTranslations('pwa.admin.form');
  const language = useLanguageName();
  const create = useCreateAnnouncement();
  const update = useUpdateAnnouncement();
  const [form, setForm] = useState<AnnouncementFormState>(() => (editing.mode === 'edit' ? formFromView(editing.item) : emptyForm(defaultBrand)));
  const [error, setError] = useState<string | null>(null);
  const brandLocales = getBrand(form.brand).locales;
  const status = contentStatus(form);
  const names = (codes: string[]) => codes.map(language).join(', ');
  const pending = create.isPending || update.isPending;
  const isEdit = editing.mode === 'edit';
  const wasActive = isEdit && editing.item.active;

  const set = <K extends keyof AnnouncementFormState>(k: K, v: AnnouncementFormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setText = (locale: string, field: keyof LocaleText, value: string) =>
    setForm((f) => ({ ...f, content: { ...f.content, [locale]: { ...(f.content[locale] ?? EMPTY_TEXT), [field]: value } } }));
  const toggleLocale = (locale: string) =>
    setForm((f) => ({ ...f, locales: f.locales.includes(locale) ? f.locales.filter((l) => l !== locale) : [...f.locales, locale] }));

  const onError = (err: unknown) => {
    const reason = apiErrorReason(err);
    if (reason && (KNOWN_ERRORS as readonly string[]).includes(reason)) {
      const missing = apiErrorDetails<{ missing?: string[] }>(err)?.missing ?? [];
      setError(t(`errors.${reason as (typeof KNOWN_ERRORS)[number]}`, { languages: names(missing) }));
    } else {
      setError(t('saveFailed'));
    }
  };

  const submit = (active: boolean) => {
    setError(null);
    if (status.partial.length) {
      setError(tf('partial', { languages: names(status.partial) }));
      return;
    }
    const payload = formPayload(form);
    const done = () => {
      toast({ message: active && !wasActive ? t('published') : t('saved'), tone: 'ok' });
      onClose();
    };
    if (editing.mode === 'create') {
      const body: UpsertAnnouncementInput = { key: form.key.trim(), brand: form.brand, active, ...payload };
      create.mutate(body, { onSuccess: done, onError });
    } else {
      const body: PatchAnnouncementInput = { ...payload, active, startsAt: payload.startsAt ?? null, endsAt: payload.endsAt ?? null };
      update.mutate({ id: editing.item.id, body }, { onSuccess: done, onError });
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(wasActive);
  };
  const publishBlocked = status.missing.length > 0 || status.partial.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? tf('editTitle', { key: editing.item.key }) : tf('createTitle')}
      maxWidth="xl"
      footer={
        <div className={styles.footer}>
          <Btn variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Btn>
          {wasActive ? (
            <Btn variant="primary" type="submit" form="announcement-form" disabled={pending || publishBlocked}>
              {tf('save')}
            </Btn>
          ) : (
            <>
              <Btn type="button" onClick={() => submit(false)} disabled={pending}>
                {tf('saveDraft')}
              </Btn>
              <Btn variant="primary" type="button" onClick={() => submit(true)} disabled={pending || publishBlocked}>
                {tf('saveAndPublish')}
              </Btn>
            </>
          )}
        </div>
      }
    >
      <form id="announcement-form" className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{tf('key')}</span>
            <input
              className={styles.input}
              value={form.key}
              onChange={(e) => set('key', e.target.value)}
              disabled={isEdit}
              required
              pattern="[a-z0-9_.\-]{3,64}"
              aria-describedby="announcement-key-hint"
            />
            <span id="announcement-key-hint" className={styles.hint}>
              {tf('keyHint')}
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{tf('site')}</span>
            <select
              className={styles.input}
              value={form.brand}
              disabled={isEdit}
              onChange={(e) => {
                const next = e.target.value as BrandId;
                setForm((f) => ({ ...f, brand: next, locales: [...getBrand(next).locales] }));
              }}
            >
              {BRAND_IDS.map((id) => (
                <option key={id} value={id}>
                  {getBrand(id).name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>{tf('audience')}</legend>
          <div className={styles.checks}>
            {brandLocales.map((l) => (
              <label key={l} className={styles.check}>
                <input type="checkbox" checked={form.locales.includes(l)} onChange={() => toggleLocale(l)} />
                <span>{language(l)}</span>
              </label>
            ))}
          </div>
          <span className={styles.hint}>{tf('audienceHint')}</span>
        </fieldset>

        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{tf('startsAt')}</span>
            <input className={styles.input} type="datetime-local" value={form.startsAt} onChange={(e) => set('startsAt', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{tf('endsAt')}</span>
            <input className={styles.input} type="datetime-local" value={form.endsAt} onChange={(e) => set('endsAt', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{tf('priority')}</span>
            <input className={styles.input} type="number" min={0} max={1000} inputMode="numeric" value={form.priority} onChange={(e) => set('priority', e.target.value)} />
            <span className={styles.hint}>{tf('priorityHint')}</span>
          </label>
        </div>
        <p className={styles.hint}>{tf('datesHint')}</p>

        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>{tf('cohort')}</legend>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{tf('plans')}</span>
              <input className={styles.input} value={form.plans} onChange={(e) => set('plans', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{tf('signedUpBefore')}</span>
              <input className={styles.input} type="date" value={form.signedUpBefore} onChange={(e) => set('signedUpBefore', e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{tf('flags')}</span>
              <input className={styles.input} value={form.flags} onChange={(e) => set('flags', e.target.value)} />
            </label>
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>{tf('content')}</legend>
          {brandLocales.map((l) => {
            const c = form.content[l] ?? EMPTY_TEXT;
            const done = status.complete.includes(l);
            return (
              <section key={l} className={styles.localeBlock} aria-label={language(l)} data-testid={`locale-${l}`}>
                <div className={styles.localeHead}>
                  <span className={styles.localeName}>
                    {language(l)} <span className={styles.code}>{l}</span>
                  </span>
                  <Pill tone={done ? 'ok' : 'warn'}>{done ? tf('complete') : tf('missing')}</Pill>
                </div>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{tf('titleField')}</span>
                  <input className={styles.input} lang={l} maxLength={120} value={c.title} onChange={(e) => setText(l, 'title', e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{tf('bodyField')}</span>
                  <textarea className={styles.textarea} lang={l} rows={3} maxLength={2000} value={c.body} onChange={(e) => setText(l, 'body', e.target.value)} />
                </label>
                <div className={styles.grid}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{tf('ctaLabel')}</span>
                    <input className={styles.input} lang={l} maxLength={40} value={c.ctaLabel} onChange={(e) => setText(l, 'ctaLabel', e.target.value)} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{tf('ctaHref')}</span>
                    <input className={styles.input} maxLength={500} value={c.ctaHref} onChange={(e) => setText(l, 'ctaHref', e.target.value)} />
                  </label>
                </div>
              </section>
            );
          })}
        </fieldset>

        {publishBlocked && status.missing.length ? (
          <p className={styles.hint} data-testid="publish-blocked">
            {tf('publishBlocked', { languages: names(status.missing) })}
          </p>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
