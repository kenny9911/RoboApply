'use client';

// Skills (+ languages) and Links.

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import type { ProfileView } from '../../../lib/api/contracts/profile';
import { useProfileMutations } from '../../../hooks/profile/useProfile';
import { LANGUAGE_LEVELS, isHttpUrl, isLinkedInProfileUrl } from './options';
import { SaveRow, SectionCard, SelectField, TextField, useDraft, type SaveState } from './parts';
import s from './profile.module.css';

type Skill = ProfileView['skills'][number];
type Language = ProfileView['languages'][number];

export function SkillsSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const { skills: putSkills, patch } = useProfileMutations();
  const skills = useDraft(profile.skills, () => profile.skills);
  const langs = useDraft(profile.languages, () => profile.languages);
  const [entry, setEntry] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const missing = profile.missing.some((m) => m.key === 'skills');

  function addSkill() {
    const name = entry.trim().slice(0, 60);
    if (!name) return;
    if (!skills.draft.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      skills.update((d) => [...d, { name, confirmed: true } satisfies Skill]);
      setState('idle');
    }
    setEntry('');
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addSkill();
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setState('saving');
    try {
      await putSkills.mutateAsync({ skills: skills.draft.slice(0, 200) });
      const cleanLangs = langs.draft.filter((l) => l.language.trim());
      await patch.mutateAsync({ languages: cleanLangs.slice(0, 20) });
      skills.markClean();
      langs.markClean();
      setState('saved');
    } catch {
      setState('error');
    }
  }

  return (
    <SectionCard id="skills" title={t('sections.skills')} intro={t('skills.intro')} missing={missing}>
      <form onSubmit={save} noValidate>
        {skills.draft.length === 0 ? <p className={s.empty}>{t('skills.empty')}</p> : null}
        <ul className={s.chips}>
          {skills.draft.map((sk) => (
            <li key={sk.name} className={s.chip}>
              {sk.name}
              <button
                type="button"
                className={s.chipRemove}
                aria-label={t('actions.remove', { name: sk.name })}
                onClick={() => {
                  skills.update((d) => d.filter((x) => x.name !== sk.name));
                  setState('idle');
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className={s.field}>
          <label className={s.label} htmlFor="profile-skill-entry">
            {t('skills.add')}
          </label>
          <div className={s.inline}>
            <input
              id="profile-skill-entry"
              className={s.input}
              value={entry}
              maxLength={60}
              placeholder={t('skills.placeholder')}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={onKey}
            />
            <Btn onClick={addSkill} disabled={!entry.trim()}>
              {t('actions.add')}
            </Btn>
          </div>
        </div>

        <fieldset className={`${s.fieldset} ${s.spaced}`}>
          <legend className={s.legend}>{t('skills.languages')}</legend>
          {langs.draft.length === 0 ? <p className={s.empty}>{t('skills.noLanguages')}</p> : null}
          <ul className={s.rows}>
            {langs.draft.map((l, i) => (
              <li key={i} className={s.row}>
                <div className={s.grid}>
                  <TextField
                    label={t('skills.language')}
                    value={l.language}
                    maxLength={40}
                    onChange={(v) => langs.update((d) => d.map((x, j) => (j === i ? { ...x, language: v } : x)))}
                  />
                  <SelectField
                    label={t('skills.level')}
                    value={l.level}
                    onChange={(v) => langs.update((d) => d.map((x, j) => (j === i ? { ...x, level: v as Language['level'] } : x)))}
                    options={LANGUAGE_LEVELS.map((lv) => ({ value: lv, label: t(`skills.levels.${lv}`) }))}
                  />
                </div>
                <div className={s.rowActions}>
                  <Btn variant="ghost" onClick={() => langs.update((d) => d.filter((_, j) => j !== i))}>
                    {t('actions.delete')}
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
          {langs.draft.length < 20 ? (
            <div className={s.actions}>
              <Btn onClick={() => langs.update((d) => [...d, { language: '', level: 'professional' }])}>{t('skills.addLanguage')}</Btn>
            </div>
          ) : null}
        </fieldset>
        <SaveRow state={state} />
      </form>
    </SectionCard>
  );
}

const LINK_KEYS_INTL = ['linkedin', 'github', 'portfolio', 'website', 'x'] as const;
const LINK_KEYS_CN = ['github', 'portfolio', 'website'] as const;
type LinkKey = (typeof LINK_KEYS_INTL)[number];

export function LinksSection({ profile }: { profile: ProfileView }) {
  const t = useTranslations('profile');
  const { patch } = useProfileMutations();
  const keys: readonly LinkKey[] = profile.availability.market === 'cn' ? LINK_KEYS_CN : LINK_KEYS_INTL;
  const { draft, update, markClean } = useDraft(profile.links, () =>
    Object.fromEntries(LINK_KEYS_INTL.map((k) => [k, profile.links[k] ?? ''])) as Record<LinkKey, string>,
  );
  const [state, setState] = useState<SaveState>('idle');
  const [touched, setTouched] = useState(false);

  const errorOf = (k: LinkKey): string | null => {
    const v = draft[k].trim();
    if (!v || !touched) return null;
    if (k === 'linkedin') return isLinkedInProfileUrl(v) ? null : t('links.linkedinInvalid');
    return isHttpUrl(v) ? null : t('links.invalid');
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    const invalid = keys.some((k) => {
      const v = draft[k].trim();
      return v && (k === 'linkedin' ? !isLinkedInProfileUrl(v) : !isHttpUrl(v));
    });
    if (invalid) {
      setState('error');
      return;
    }
    setState('saving');
    const links = Object.fromEntries(keys.map((k) => [k, draft[k].trim()]).filter(([, v]) => v));
    try {
      await patch.mutateAsync({ links });
      markClean();
      setState('saved');
    } catch {
      setState('error');
    }
  }

  return (
    <SectionCard id="links" title={t('sections.links')} intro={t('links.intro')} optional>
      <form onSubmit={save} noValidate>
        <div className={s.grid}>
          {keys.map((k) => (
            <TextField
              key={k}
              label={t(`links.${k}`)}
              type="url"
              inputMode="url"
              value={draft[k]}
              onChange={(v) => {
                update((d) => ({ ...d, [k]: v }));
                setState('idle');
              }}
              hint={k === 'linkedin' ? t('links.linkedinHint') : undefined}
              error={errorOf(k)}
              maxLength={300}
            />
          ))}
        </div>
        <SaveRow state={state} />
      </form>
    </SectionCard>
  );
}
