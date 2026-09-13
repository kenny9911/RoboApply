'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Btn, EmptyState, PageHeader } from '../v3/primitives';
import { jobSearchApi, JOB_SEARCH_OPENAPI_URL } from '../../lib/api/job-search';
import type { JobSearchKey } from '../../lib/api/job-search-types';
import { jobDate } from './format';

export function ApiKeyWorkspace() {
  const t = useTranslations('jobSearchApi');
  const tSearch = useTranslations('jobSearch');
  const locale = useLocale();
  const [keys, setKeys] = useState<JobSearchKey[] | null>(null);
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretKeyId, setSecretKeyId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    jobSearchApi.keys(controller.signal).then(({ keys: items }) => {
      if (!controller.signal.aborted) setKeys(items);
    }).catch(() => { if (!controller.signal.aborted) setError('keys_error'); });
    return () => controller.abort();
  }, [reload]);

  async function createKey(event: FormEvent) {
    event.preventDefault();
    setError(null); setNotice(null); setCreating(true);
    try {
      const result = await jobSearchApi.createKey(name.trim());
      setSecret(result.token); setSecretKeyId(result.key.id); setCopyStatus('idle'); setName('');
      setKeys((items) => [result.key, ...(items ?? []).filter((key) => key.id !== result.key.id)]);
    } catch { setError('create_error'); }
    finally { setCreating(false); }
  }

  async function copySecret() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); setCopyStatus('copied'); }
    catch { setCopyStatus('error'); }
  }

  async function revokeKey(id: string) {
    setError(null); setNotice(null); setRevoking(id);
    try {
      await jobSearchApi.revokeKey(id);
      setKeys((items) => items?.filter((key) => key.id !== id) ?? []);
      setConfirmRevoke(null); setNotice('revoked');
      if (id === secretKeyId) { setSecret(null); setSecretKeyId(null); }
    } catch { setError('revoke_error'); }
    finally { setRevoking(null); }
  }

  return (
    <div className="job-search-workspace job-search-key-workspace">
      <nav className="job-search-nav" aria-label={t('keys_title')}><Link href="/job-search">← {tSearch('title')}</Link><Link href="/developers/job-search">{t('docs')} ↗</Link></nav>
      <div className="job-search-hero"><PageHeader eyebrow={t('eyebrow')} title={t('keys_title')} sub={t('keys_intro')} /></div>
      {error ? <div className="job-search-notice is-warning" role="alert">{t(error)}{error === 'keys_error' ? <Btn onClick={() => setReload((value) => value + 1)}>{tSearch('retry')}</Btn> : null}</div> : null}
      {notice ? <p role="status" className="job-search-notice">{t(notice)}</p> : null}
      {secret ? <section className="job-search-secret" aria-labelledby="job-search-secret-title">
        <h2 id="job-search-secret-title">{t('secret_title')}</h2><p>{t('secret_body')}</p>
        <label className="job-search-field">{t('secret_label')}<input value={secret} readOnly spellCheck={false} autoComplete="off" onFocus={(event) => event.target.select()} /></label>
        <div className="job-search-secret-actions"><Btn variant="primary" onClick={copySecret}>{copyStatus === 'copied' ? t('copied') : t('copy')}</Btn><Btn onClick={() => { setSecret(null); setSecretKeyId(null); setCopyStatus('idle'); }}>{t('dismiss')}</Btn></div>
        {copyStatus === 'error' ? <p role="alert">{t('copy_error')}</p> : copyStatus === 'copied' ? <span role="status" className="sr-only">{t('copied')}</span> : null}
      </section> : null}
      <div className="job-search-key-grid">
        <section className="job-search-key-main">
          <form onSubmit={createKey} className="job-search-key-form"><label className="job-search-field">{t('key_name')}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('key_placeholder')} required minLength={1} maxLength={80} disabled={creating || !!secret} autoComplete="off" /></label><Btn type="submit" variant="primary" disabled={creating || !!secret || !name.trim() || keys === null}>{creating ? t('creating') : t('create')}</Btn></form>
          {keys === null && !error ? <p role="status">{t('keys_loading')}</p> : null}
          {keys?.length === 0 ? <EmptyState title={t('keys_empty')} sub={t('keys_empty_body')} /> : null}
          {keys && keys.length > 0 ? <ul className="job-search-key-list">{keys.map((key) => {
            const expires = jobDate(key.expiresAt, locale);
            const expired = key.expiresAt ? Date.parse(key.expiresAt) <= Date.now() : false;
            return <li key={key.id}>
              <div className="job-search-key-heading"><div><h2>{key.name}</h2><code>{key.prefix}…</code></div><span className="job-search-source-tag">{expired ? t('expired') : t('active')}</span></div>
              <div className="job-search-key-meta"><span>{t('created', { date: jobDate(key.createdAt, locale) ?? '—' })}</span><span>{key.lastUsedAt ? t('last_used', { date: jobDate(key.lastUsedAt, locale) ?? '—' }) : t('never_used')}</span>{expires ? <span>{t('expires', { date: expires })}</span> : null}</div>
              {confirmRevoke === key.id ? <div className="job-search-key-confirm"><p>{t('revoke_confirm')}</p><div><Btn onClick={() => revokeKey(key.id)} disabled={!!revoking}>{revoking === key.id ? t('revoking') : t('revoke')}</Btn><Btn variant="ghost" onClick={() => setConfirmRevoke(null)} disabled={!!revoking}>{t('cancel')}</Btn></div></div> : <Btn onClick={() => setConfirmRevoke(key.id)} disabled={!!revoking}>{t('revoke')}</Btn>}
            </li>;
          })}</ul> : null}
        </section>
        <aside className="job-search-key-aside"><h2>{t('access_title')}</h2><p>{t('access_body')}</p><h2>{t('terms_title')}</h2><p>{t('terms_body')}</p><Btn as="a" href={JOB_SEARCH_OPENAPI_URL} target="_blank" rel="noopener noreferrer">{t('openapi')} ↗</Btn></aside>
      </div>
    </div>
  );
}
