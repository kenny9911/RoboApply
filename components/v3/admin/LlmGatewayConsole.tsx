'use client';

// components/v3/admin/LlmGatewayConsole.tsx — /admin/llm, the LLM gateway.
//
// Two panels, for the environment this server runs in:
//   Providers            named provider entries: a type, an API base URL, an API
//                        key, and the model list the provider returns for that
//                        key. Add, edit, turn off, fetch models, remove.
//   Functionality areas  Default and one area per kind of work (match resume,
//                        parse resume, visual, evaluation, insights, …). Each
//                        is assigned a provider entry, a model and a reasoning
//                        effort (Medium to start), plus up to three ordered
//                        fallback models, or left unassigned, which uses the
//                        Default area. Under each area: what its calls resolve
//                        to right now and where that value comes from.
//
// An API key is typed here and sent once; the server never sends it back (an
// entry shows a preview such as `sk-…ab12`). A model can be picked from the
// fetched list or typed, for a model the provider does not list.

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import {
  LLM_PROVIDER_TYPES,
  adminLlmApi,
  type LlmAreaRoute,
  type LlmAreaRouteInput,
  type LlmAreaView,
  type LlmEffort,
  type LlmGatewayBrand,
  type LlmGatewayOverview,
  type LlmKeyResolution,
  type LlmModelListResult,
  type LlmProviderEntry,
  type LlmProviderInput,
  type LlmProviderType,
} from '../../../lib/api/adminLlm';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import { Btn } from '../primitives/Btn';
import { PageHeader } from '../primitives/PageHeader';
import { Tag } from '../primitives/Tag';
import { IconRefresh } from '../primitives/Iconset';
import { AdminGate } from './AdminGate';
import { AdminNav } from './AdminNav';
import { fmtCount, fmtLongDate } from './format';
import styles from './console.module.css';

type T = ReturnType<typeof useTranslations>;

/** Vendor names are data, not copy. `newapi` (any OpenAI-compatible endpoint) is named in the copy. */
export const PROVIDER_TYPE_NAMES: Readonly<Record<Exclude<LlmProviderType, 'newapi'>, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot (Kimi)',
  minimax: 'MiniMax',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

const BRANDS: readonly LlmGatewayBrand[] = ['roboapply', 'goapply'];
const BRAND_NAMES: Readonly<Record<LlmGatewayBrand, string>> = { roboapply: 'RoboApply', goapply: 'GoApply' };

// next-intl renders an unknown key as its dotted path, so only known codes are looked up.
const SAVE_ERRORS = new Set([
  'invalid_name', 'duplicate_name', 'invalid_type', 'invalid_base_url', 'key_required', 'key_required_for_new_url', 'too_many_providers',
  'not_found', 'invalid_notes', 'encryption_unavailable', 'invalid_area', 'invalid_route', 'unknown_provider', 'tools_unsupported', 'provider_in_use',
  'invalid_effort', 'invalid_fallback', 'duplicate_fallback', 'too_many_fallbacks',
]);
const LIST_ERRORS = new Set([
  'invalid_base_url', 'key_required', 'auth_rejected', 'not_supported', 'rate_limited', 'timeout', 'unreachable', 'invalid_response', 'response_too_large', 'provider_error',
]);

export function typeLabel(type: string, t: T): string {
  return type === 'newapi' ? t('types.newapi') : PROVIDER_TYPE_NAMES[type as Exclude<LlmProviderType, 'newapi'>] ?? type;
}

function saveError(err: unknown, t: T, values?: Record<string, number>): string {
  const code = apiErrorCode(err);
  return code && SAVE_ERRORS.has(code) ? t(`errors.${code}`, values) : t('errors.generic');
}

/** One line for the result of a model-list request. */
export function modelListText(result: LlmModelListResult, t: T, locale: string): string {
  if (result.ok) return t(result.truncated ? 'modelList.okTruncated' : 'modelList.ok', { count: result.models.length, n: fmtCount(result.models.length, locale) });
  return LIST_ERRORS.has(result.code) ? t(`modelList.${result.code}`) : t('modelList.provider_error');
}

const queryKey = (brand: LlmGatewayBrand) => ['admin', 'llm-gateway', brand] as const;

export function LlmGatewayConsole() {
  return (
    <AdminGate>
      <LlmGatewayInner />
    </AdminGate>
  );
}

function LlmGatewayInner() {
  const t = useTranslations('admin.console.llm');
  const tc = useTranslations('admin.console');
  const hostBrand = useBrandId();
  const [brand, setBrand] = useState<LlmGatewayBrand>(hostBrand === 'goapply' ? 'goapply' : 'roboapply');
  const q = useQuery({ queryKey: queryKey(brand), queryFn: () => adminLlmApi.overview(brand) });
  const d = q.data;
  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      <AdminNav />
      {q.isError ? (
        <div className={styles.alertBox} role="alert">
          <strong>{tc('error')}</strong>
          <div className={styles.actions}><Btn onClick={() => void q.refetch()}>{tc('retry')}</Btn></div>
        </div>
      ) : !d ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : (
        <>
          <div className={styles.actions}>
            <Tag tone="strong">{t(`environment.${d.environment}`)}</Tag>
            <Btn variant="ghost" icon={<IconRefresh size={15} />} disabled={q.isFetching} onClick={() => void q.refetch()}>{t(q.isFetching ? 'refreshing' : 'refresh')}</Btn>
          </div>
          {d.dbDisabled && <p className={styles.alertBox} role="status">{t('dbDisabled')}</p>}
          {!d.encryptionReady && <p className={styles.alertBox} role="status">{t('encryptionMissing')}</p>}
          <ProvidersPanel overview={d} brand={brand} />
          <AreasPanel overview={d} brand={brand} onBrand={setBrand} />
        </>
      )}
    </div>
  );
}

// ── Providers ────────────────────────────────────────────────────────────

function ProvidersPanel({ overview, brand }: { overview: LlmGatewayOverview; brand: LlmGatewayBrand }) {
  const t = useTranslations('admin.console.llm');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const full = overview.providers.length >= overview.maxProviders;
  return (
    <section className={styles.panel} aria-labelledby="llm-providers">
      <div className={styles.panelHead}>
        <div>
          <h2 id="llm-providers">{t('providers.title')}</h2>
          <p className={styles.muted}>{t('providers.sub')}</p>
        </div>
        {editing !== 'new' && (
          <Btn variant="primary" disabled={full} onClick={() => setEditing('new')}>{t('providers.add')}</Btn>
        )}
      </div>
      {full && <p className={styles.muted}>{t('providers.full', { max: overview.maxProviders })}</p>}
      {editing === 'new' && <ProviderForm overview={overview} brand={brand} entry={null} onDone={() => setEditing(null)} />}
      {overview.providers.length === 0 && editing !== 'new' ? (
        <p className={styles.muted}>{t('providers.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {overview.providers.map((p) => (
            <ProviderCard key={p.id} entry={p} overview={overview} brand={brand} editing={editing === p.id} onEdit={(on) => setEditing(on ? p.id : null)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function useOverviewWriter(brand: LlmGatewayBrand) {
  const qc = useQueryClient();
  return (overview: LlmGatewayOverview) => qc.setQueryData(queryKey(brand), overview);
}

function ProviderCard({ entry, overview, brand, editing, onEdit }: {
  entry: LlmProviderEntry;
  overview: LlmGatewayOverview;
  brand: LlmGatewayBrand;
  editing: boolean;
  onEdit: (on: boolean) => void;
}) {
  const t = useTranslations('admin.console.llm');
  const locale = useLocale();
  const write = useOverviewWriter(brand);
  const titleId = useId();
  const [listed, setListed] = useState<LlmModelListResult | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fetchModels = useMutation({
    mutationFn: () => adminLlmApi.fetchModels(brand, entry.id),
    onSuccess: (r) => { setListed(r.models); write(r.overview); },
  });
  const toggle = useMutation({
    mutationFn: () => adminLlmApi.updateProvider(brand, entry.id, { name: entry.name, type: entry.type, baseUrl: entry.baseUrl ?? '', apiKey: '', enabled: !entry.enabled, notes: entry.notes ?? '' }),
    onSuccess: (r) => write(r.overview),
  });
  const remove = useMutation({ mutationFn: () => adminLlmApi.deleteProvider(brand, entry.id), onSuccess: write });
  const failure = toggle.error ?? remove.error ?? fetchModels.error;
  return (
    <li className={styles.card} aria-labelledby={titleId}>
      <div className={styles.cardHead}>
        <div>
          <h3 id={titleId}>{entry.name}</h3>
          <p>{typeLabel(entry.type, t)} · <span className={styles.code}>{entry.effectiveBaseUrl ?? t('providers.noUrl')}</span></p>
        </div>
        <div className={styles.tags}>
          {!entry.enabled && <Tag tone="warn">{t('providers.off')}</Tag>}
          {entry.keyUnreadable && <Tag tone="warn">{t('providers.keyUnreadable')}</Tag>}
          {entry.enabled && entry.usable && <Tag tone="strong">{t('providers.ready')}</Tag>}
        </div>
      </div>
      <dl className={styles.facts}>
        <div><dt>{t('providers.key')}</dt><dd>{entry.hasKey ? entry.keyPreview : t('providers.noKey')}</dd></div>
        <div>
          <dt>{t('providers.models')}</dt>
          <dd>{entry.modelsFetchedAt ? t('providers.modelCount', { count: entry.models.length, n: fmtCount(entry.models.length, locale) }) : t('providers.modelsNever')}</dd>
        </div>
        {entry.modelsFetchedAt && <div><dt>{t('providers.fetchedAt')}</dt><dd>{fmtLongDate(entry.modelsFetchedAt, locale)}</dd></div>}
      </dl>
      {entry.keyUnreadable && <p className={styles.error}>{t('providers.keyUnreadableHelp')}</p>}
      {entry.notes && <p className={styles.quote}>{entry.notes}</p>}
      {listed && <p className={listed.ok ? styles.success : styles.error} role="status">{modelListText(listed, t, locale)}</p>}
      {failure ? <p className={styles.error} role="alert">{saveError(failure, t)}</p> : null}
      {showModels && entry.models.length > 0 && (
        <ul className={styles.tagList} aria-label={t('providers.models')}>
          {entry.models.map((m) => <li key={m}><span className={styles.code}>{m}</span></li>)}
        </ul>
      )}
      {editing ? (
        <ProviderForm overview={overview} brand={brand} entry={entry} onDone={() => onEdit(false)} />
      ) : (
        <div className={styles.actions}>
          <Btn onClick={() => onEdit(true)}>{t('providers.edit')}</Btn>
          <Btn disabled={fetchModels.isPending || !entry.hasKey && entry.type !== 'ollama'} onClick={() => fetchModels.mutate()}>
            {t(fetchModels.isPending ? 'providers.fetching' : entry.modelsFetchedAt ? 'providers.refreshModels' : 'providers.fetchModels')}
          </Btn>
          {entry.models.length > 0 && (
            <Btn variant="ghost" aria-expanded={showModels} onClick={() => setShowModels((v) => !v)}>{t(showModels ? 'providers.hideModels' : 'providers.showModels')}</Btn>
          )}
          <Btn variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate()}>{t(entry.enabled ? 'providers.turnOff' : 'providers.turnOn')}</Btn>
          {confirmRemove ? (
            <>
              <Btn disabled={remove.isPending} onClick={() => remove.mutate()}>{t('providers.removeConfirm', { name: entry.name })}</Btn>
              <Btn variant="ghost" onClick={() => setConfirmRemove(false)}>{t('cancel')}</Btn>
            </>
          ) : (
            <Btn variant="ghost" onClick={() => setConfirmRemove(true)}>{t('providers.remove')}</Btn>
          )}
        </div>
      )}
    </li>
  );
}

function ProviderForm({ overview, brand, entry, onDone }: {
  overview: LlmGatewayOverview;
  brand: LlmGatewayBrand;
  entry: LlmProviderEntry | null;
  onDone: () => void;
}) {
  const t = useTranslations('admin.console.llm');
  const locale = useLocale();
  const write = useOverviewWriter(brand);
  const id = useId();
  const [form, setForm] = useState<LlmProviderInput>({
    name: entry?.name ?? '',
    type: entry?.type ?? 'newapi',
    baseUrl: entry?.baseUrl ?? '',
    apiKey: '',
    enabled: entry?.enabled ?? true,
    notes: entry?.notes ?? '',
  });
  const [tested, setTested] = useState<LlmModelListResult | null>(null);
  const info = overview.providerTypes.find((p) => p.type === form.type);
  const set = <K extends keyof LlmProviderInput>(key: K, value: LlmProviderInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === 'type' || key === 'baseUrl' || key === 'apiKey') setTested(null);
  };
  const test = useMutation({
    mutationFn: () => adminLlmApi.testProvider({ type: form.type, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() }),
    onSuccess: (r) => setTested(r.models),
  });
  const save = useMutation({
    mutationFn: () => {
      const input = { ...form, name: form.name.trim(), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), notes: form.notes.trim() };
      return entry ? adminLlmApi.updateProvider(brand, entry.id, input) : adminLlmApi.createProvider(brand, input);
    },
    onSuccess: (r) => { write(r.overview); onDone(); },
  });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const keyNeeded = !entry && form.type !== 'ollama';
  const canTest = form.type === 'ollama' || form.apiKey.trim().length > 0;
  return (
    <form className={styles.filters} onSubmit={onSubmit} noValidate aria-label={t(entry ? 'form.editTitle' : 'form.addTitle')}>
      <label className={styles.field}>
        {t('form.name')}
        <input value={form.name} maxLength={60} required onChange={(e) => set('name', e.target.value)} aria-describedby={`${id}-name`} />
        <span className={styles.muted} id={`${id}-name`}>{t('form.nameHint')}</span>
      </label>
      <label className={styles.field}>
        {t('form.type')}
        <select value={form.type} onChange={(e) => set('type', e.target.value as LlmProviderType)} aria-describedby={`${id}-type`}>
          {LLM_PROVIDER_TYPES.map((type) => <option key={type} value={type}>{typeLabel(type, t)}</option>)}
        </select>
        <span className={styles.muted} id={`${id}-type`}>{t(info?.tools ? 'form.typeHint' : 'form.typeHintNoTools')}</span>
      </label>
      <label className={`${styles.field} ${styles.full}`}>
        {t('form.baseUrl')}
        <input
          value={form.baseUrl}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={info?.defaultBaseUrl ?? 'https://api.example.com/v1'}
          required={info?.baseUrl === 'required'}
          onChange={(e) => set('baseUrl', e.target.value)}
          aria-describedby={`${id}-url`}
        />
        <span className={styles.muted} id={`${id}-url`}>
          {info?.baseUrl === 'required' ? t('form.baseUrlRequired') : t('form.baseUrlOptional', { url: info?.defaultBaseUrl ?? '' })}
        </span>
      </label>
      <label className={`${styles.field} ${styles.full}`}>
        {t('form.apiKey')}
        <input
          type="password"
          value={form.apiKey}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required={keyNeeded}
          placeholder={entry?.hasKey ? entry.keyPreview : ''}
          onChange={(e) => set('apiKey', e.target.value)}
          aria-describedby={`${id}-key`}
        />
        <span className={styles.muted} id={`${id}-key`}>{t(entry?.hasKey ? 'form.apiKeyKeep' : 'form.apiKeyHint')}</span>
      </label>
      <label className={`${styles.field} ${styles.full}`}>
        {t('form.notes')}
        <textarea value={form.notes} maxLength={2000} onChange={(e) => set('notes', e.target.value)} />
      </label>
      <label className={`${styles.check} ${styles.full}`}>
        <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        {t('form.enabled')}
      </label>
      {tested && <p className={`${tested.ok ? styles.success : styles.error} ${styles.full}`} role="status">{modelListText(tested, t, locale)}</p>}
      {test.isError && <p className={`${styles.error} ${styles.full}`} role="alert">{t('errors.generic')}</p>}
      {save.isError && <p className={`${styles.error} ${styles.full}`} role="alert">{saveError(save.error, t)}</p>}
      <div className={`${styles.actions} ${styles.full}`}>
        <Btn variant="primary" type="submit" disabled={save.isPending || !form.name.trim()}>{t(save.isPending ? 'form.saving' : 'form.save')}</Btn>
        <Btn type="button" disabled={test.isPending || !canTest} onClick={() => test.mutate()}>{t(test.isPending ? 'form.testing' : 'form.test')}</Btn>
        <Btn variant="ghost" type="button" onClick={onDone}>{t('cancel')}</Btn>
      </div>
      <p className={`${styles.muted} ${styles.full}`}>{t('form.saveHint')}</p>
    </form>
  );
}

// ── Functionality areas ──────────────────────────────────────────────────

function AreasPanel({ overview, brand, onBrand }: { overview: LlmGatewayOverview; brand: LlmGatewayBrand; onBrand: (b: LlmGatewayBrand) => void }) {
  const t = useTranslations('admin.console.llm');
  return (
    <section className={styles.panel} aria-labelledby="llm-areas">
      <div className={styles.panelHead}>
        <div>
          <h2 id="llm-areas">{t('areas.title')}</h2>
          <p className={styles.muted}>{t('areas.sub')}</p>
        </div>
        <label className={styles.field}>
          {t('areas.brand')}
          <select value={brand} onChange={(e) => onBrand(e.target.value as LlmGatewayBrand)}>
            {BRANDS.map((b) => <option key={b} value={b}>{BRAND_NAMES[b]}</option>)}
          </select>
        </label>
      </div>
      {brand === 'goapply' && <p className={styles.muted}>{t('areas.goapplyNote', { site: BRAND_NAMES.goapply, shared: BRAND_NAMES.roboapply })}</p>}
      {overview.providers.length === 0 && <p className={styles.muted}>{t('areas.noProviders')}</p>}
      <ul className={styles.list}>
        {overview.areas.map((a) => <AreaCard key={`${brand}:${a.area}`} view={a} overview={overview} brand={brand} />)}
      </ul>
    </section>
  );
}

/** Where a key's value comes from, in words. */
function sourceText(key: LlmKeyResolution, view: LlmAreaView, overview: LlmGatewayOverview, t: T): string {
  if (!key.effective) {
    return view.area === 'default' ? t('source.noneDefault') : t(`source.fallback.${view.area}`, { model: overview.defaultModel ?? t('source.noDefault') });
  }
  const shared = { shared: BRAND_NAMES.roboapply };
  if (key.via === 'area') return key.shared ? t('source.sharedArea', shared) : t('source.assigned');
  if (key.via === 'default') return key.shared ? t('source.sharedDefault', shared) : t('source.default');
  if (key.via === 'override') return t('source.override');
  if (key.via === 'shared') return t('source.shared', shared);
  return t('source.env', { name: key.envName });
}

/** One model of an assignment as the form edits it. */
interface TargetDraft {
  providerId: string;
  model: string;
  effort: LlmEffort;
}

interface RouteDraft {
  primary: TargetDraft;
  fallbacks: TargetDraft[];
}

function draftOf(route: LlmAreaRoute | null, defaultEffort: LlmEffort): RouteDraft {
  return {
    primary: { providerId: route?.providerId ?? '', model: route?.model ?? '', effort: route?.effort ?? defaultEffort },
    fallbacks: (route?.fallbacks ?? []).map((f) => ({ providerId: f.providerId, model: f.model, effort: f.effort })),
  };
}

/** A draft as it would be saved, for the dirty check and the request. */
function savedShape(d: RouteDraft): LlmAreaRouteInput | null {
  if (!d.primary.providerId) return null;
  const target = (x: TargetDraft) => ({ providerId: x.providerId, model: x.model.trim(), effort: x.effort });
  return { ...target(d.primary), fallbacks: d.fallbacks.map(target) };
}

const targetKey = (x: Pick<TargetDraft, 'providerId' | 'model'>) => `${x.providerId}::${x.model.trim()}`;

/** Provider, model (from the entry's list or typed) and reasoning effort for one target. */
function TargetFields({ draft, overview, inheritLabel, onChange, describedBy }: {
  draft: TargetDraft;
  overview: LlmGatewayOverview;
  /** The "not assigned" option of the primary model; fallbacks always name a provider. */
  inheritLabel: string | null;
  onChange: (next: TargetDraft) => void;
  describedBy: string;
}) {
  const t = useTranslations('admin.console.llm');
  const id = useId();
  const provider = overview.providers.find((p) => p.id === draft.providerId);
  return (
    <>
      <label className={styles.field}>
        {t('areas.provider')}
        <select value={draft.providerId} onChange={(e) => onChange({ ...draft, providerId: e.target.value, model: '' })}>
          {inheritLabel !== null ? <option value="">{inheritLabel}</option> : <option value="" disabled>{t('areas.chooseProvider')}</option>}
          {overview.providers.map((p) => (
            <option key={p.id} value={p.id}>{p.enabled ? p.name : t('areas.providerOff', { name: p.name })}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        {t('areas.model')}
        <input
          value={draft.model}
          list={`${id}-models`}
          disabled={!draft.providerId}
          maxLength={200}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange({ ...draft, model: e.target.value })}
          aria-describedby={describedBy}
        />
        <datalist id={`${id}-models`}>
          {(provider?.models ?? []).map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
      <label className={styles.field}>
        {t('areas.effort')}
        <select value={draft.effort} disabled={!draft.providerId} onChange={(e) => onChange({ ...draft, effort: e.target.value as LlmEffort })} aria-describedby={describedBy}>
          {overview.efforts.map((e) => <option key={e} value={e}>{t(`effort.${e}`)}</option>)}
        </select>
      </label>
    </>
  );
}

function AreaCard({ view, overview, brand }: { view: LlmAreaView; overview: LlmGatewayOverview; brand: LlmGatewayBrand }) {
  const t = useTranslations('admin.console.llm');
  const write = useOverviewWriter(brand);
  const id = useId();
  const saved = draftOf(view.route, overview.defaultEffort);
  const savedKey = JSON.stringify(savedShape(saved));
  const [draft, setDraft] = useState<RouteDraft>(saved);
  // The saved assignment is the starting point again whenever it changes (a save, a refresh).
  useEffect(() => {
    setDraft(draftOf(view.route, overview.defaultEffort));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- savedKey stands for view.route
  }, [savedKey, overview.defaultEffort]);
  const save = useMutation({
    mutationFn: (route: LlmAreaRouteInput | null) => adminLlmApi.saveRoutes(brand, { [view.area]: route }),
    onSuccess: write,
  });
  const next = savedShape(draft);
  const dirty = JSON.stringify(next) !== savedKey;
  const typeOf = (providerId: string) => overview.providers.find((p) => p.id === providerId)?.type;
  const streamsTools = (providerId: string) => !!overview.providerTypes.find((p) => p.type === typeOf(providerId))?.tools;
  const provider = overview.providers.find((p) => p.id === draft.primary.providerId);
  const assigned = !!draft.primary.providerId;
  const targets = assigned ? [draft.primary, ...draft.fallbacks] : [];
  const toolsBlocked = view.needsTools && targets.some((x) => x.providerId && !streamsTools(x.providerId));
  const incomplete = targets.some((x) => !x.providerId || !x.model.trim());
  const duplicate = new Set(targets.map(targetKey)).size !== targets.length;
  const full = draft.fallbacks.length >= overview.maxFallbacks;
  const setPrimary = (primary: TargetDraft) =>
    setDraft((d) => ({ primary, fallbacks: primary.providerId ? d.fallbacks : [] }));
  const setFallback = (index: number, value: TargetDraft) =>
    setDraft((d) => ({ ...d, fallbacks: d.fallbacks.map((f, i) => (i === index ? value : f)) }));
  const moveFallback = (index: number, by: -1 | 1) =>
    setDraft((d) => {
      const list = [...d.fallbacks];
      const to = index + by;
      if (to < 0 || to >= list.length) return d;
      [list[index], list[to]] = [list[to], list[index]];
      return { ...d, fallbacks: list };
    });
  const removeFallback = (index: number) => setDraft((d) => ({ ...d, fallbacks: d.fallbacks.filter((_, i) => i !== index) }));
  const addFallback = () =>
    setDraft((d) => ({ ...d, fallbacks: [...d.fallbacks, { providerId: '', model: '', effort: overview.defaultEffort }] }));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(next);
  };
  const hintId = `${id}-model-hint`;
  return (
    <li className={styles.card} aria-labelledby={`${id}-title`}>
      <div className={styles.cardHead}>
        <div>
          <h3 id={`${id}-title`}>{t(`area.${view.area}.title`)}</h3>
          <p>{t(`area.${view.area}.sub`)}</p>
        </div>
        <div className={styles.tags}>
          {view.route ? (
            <Tag tone={view.routeStatus === 'ok' ? 'strong' : 'warn'}>{t(view.routeStatus === 'ok' ? 'areas.assigned' : 'areas.notInEffect')}</Tag>
          ) : view.inheritsDefault ? (
            <Tag>{t('areas.usesDefault')}</Tag>
          ) : (
            <Tag>{t('areas.inherits')}</Tag>
          )}
        </div>
      </div>
      {view.route && view.routeStatus && view.routeStatus !== 'ok' && <p className={styles.error}>{t(`routeStatus.${view.routeStatus}`)}</p>}
      {view.route && view.routeStatus === 'ok' && view.modelListed === false && <p className={styles.muted}>{t('areas.modelNotListed')}</p>}
      <form className={styles.filters} onSubmit={onSubmit} noValidate>
        <TargetFields
          draft={draft.primary}
          overview={overview}
          inheritLabel={t(view.area === 'default' ? 'areas.inheritOptionDefault' : 'areas.inheritOption')}
          onChange={setPrimary}
          describedBy={hintId}
        />
        <p className={`${styles.muted} ${styles.full}`} id={hintId}>
          {toolsBlocked
            ? t('areas.toolsBlocked')
            : assigned && provider && provider.models.length === 0
              ? t('areas.noModelList')
              : view.needsTools
                ? t('areas.needsTools')
                : view.needsImages
                  ? t('areas.needsImages')
                  : t('areas.modelHint')}
          {' '}{t('areas.effortHint')}
        </p>
        {assigned && (
          <div className={styles.subgroup} role="group" aria-labelledby={`${id}-fallbacks`}>
            <p className={styles.factsTitle} id={`${id}-fallbacks`}>{t('areas.fallbacks')}</p>
            <p className={styles.muted}>{t('areas.fallbacksHint', { max: overview.maxFallbacks })}</p>
            {draft.fallbacks.length > 0 && (
              <ol className={styles.list} aria-labelledby={`${id}-fallbacks`}>
                {draft.fallbacks.map((f, i) => {
                  const savedHere = view.route?.fallbacks[i];
                  const status = savedHere && targetKey(savedHere) === targetKey(f) ? view.fallbackStatus[i] : undefined;
                  const unlisted = savedHere && targetKey(savedHere) === targetKey(f) ? view.fallbackListed[i] === false : false;
                  return (
                    <li key={i} className={styles.subRow}>
                      <p className={styles.rowLabel}>{t('areas.fallbackN', { n: i + 1 })}</p>
                      <TargetFields draft={f} overview={overview} inheritLabel={null} onChange={(v) => setFallback(i, v)} describedBy={`${id}-fallbacks`} />
                      <div className={styles.actions}>
                        <Btn variant="ghost" type="button" disabled={i === 0} onClick={() => moveFallback(i, -1)} aria-label={t('areas.moveUpLabel', { n: i + 1 })}>{t('areas.moveUp')}</Btn>
                        <Btn variant="ghost" type="button" disabled={i === draft.fallbacks.length - 1} onClick={() => moveFallback(i, 1)} aria-label={t('areas.moveDownLabel', { n: i + 1 })}>{t('areas.moveDown')}</Btn>
                        <Btn variant="ghost" type="button" onClick={() => removeFallback(i)} aria-label={t('areas.removeFallbackLabel', { n: i + 1 })}>{t('areas.removeFallback')}</Btn>
                      </div>
                      {status && status !== 'ok' && <p className={`${styles.error} ${styles.full}`}>{t(`routeStatus.${status}`)}</p>}
                      {unlisted && <p className={`${styles.muted} ${styles.full}`}>{t('areas.modelNotListed')}</p>}
                    </li>
                  );
                })}
              </ol>
            )}
            <div className={styles.actions}>
              <Btn type="button" disabled={full} onClick={addFallback}>{t('areas.addFallback')}</Btn>
              {full && <span className={styles.muted}>{t('areas.fallbacksFull', { max: overview.maxFallbacks })}</span>}
            </div>
          </div>
        )}
        {duplicate && <p className={`${styles.error} ${styles.full}`} role="status">{t('errors.duplicate_fallback')}</p>}
        <div className={`${styles.actions} ${styles.full}`}>
          <Btn variant="primary" type="submit" disabled={save.isPending || !dirty || toolsBlocked || incomplete || duplicate}>
            {t(save.isPending ? 'form.saving' : assigned || !view.route ? 'areas.save' : 'areas.clear')}
          </Btn>
        </div>
        {save.isError && <p className={`${styles.error} ${styles.full}`} role="alert">{saveError(save.error, t, { max: overview.maxFallbacks })}</p>}
      </form>
      <p className={styles.factsTitle} id={`${id}-now`}>{t('areas.now')}</p>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-labelledby={`${id}-now`}>
          <thead>
            <tr><th scope="col">{t('areas.colSetting')}</th><th scope="col">{t('areas.colModel')}</th><th scope="col">{t('areas.colSource')}</th></tr>
          </thead>
          <tbody>
            {view.keys.map((k) => {
              const entry = k.providerId ? overview.providers.find((p) => p.id === k.providerId) : undefined;
              const via = entry ? entry.name : k.providerType ? typeLabel(k.providerType, t) : null;
              return (
                <tr key={k.key}>
                  <th scope="row">{t(`setting.${k.key}`)}</th>
                  <td className={styles.wrap}>
                    {k.model ? <><span className={styles.code}>{k.model}</span>{via ? ` · ${via}` : ''}</> : '—'}
                  </td>
                  <td className={styles.wrap}>{sourceText(k, view, overview, t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </li>
  );
}
