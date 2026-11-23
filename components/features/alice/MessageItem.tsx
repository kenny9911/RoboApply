'use client';

// One message of the conversation. The person's words sit in a recessed
// bubble on the right; Alice's sit on the tile with her mark. Typed blocks are
// worded here from the `alice` messages (never a model's text): the greeting,
// the resume read, what she noted, the profiles ready, a version, a save, the
// jobs found, the applications facts, a reminder, a notice. Blocks that carry
// her work (a version, a save) take her blue rule.

import { useLocale, useTranslations } from 'next-intl';

import type { AliceBlock, AliceMessageView } from '../../../lib/api/contracts/alice';
import { IconCheck, IconInfo } from '../../v3/primitives/Iconset';
import { AliceMark } from './AliceMark';
import { dynamic, formatDay, isUnnamed, joinList, type AliceRegion } from './model';
import s from './alice.module.css';

export interface MessageItemProps {
  message: AliceMessageView;
  /** The previous message is Alice's too (her mark and name are shown once per run). */
  continued: boolean;
  /** Open a region (the phone switches to it; on desktop the canvas shows it). */
  onOpen: (region: AliceRegion) => void;
  /** Set (or clear, `date` null) a follow-up date from a "which one?" choice. */
  onRemind: (entryId: string, date: string | null) => void;
  reminderBusy: boolean;
}

function Block({ block, onOpen, onRemind, reminderBusy }: { block: AliceBlock } & Pick<MessageItemProps, 'onOpen' | 'onRemind' | 'reminderBusy'>) {
  const t = useTranslations('alice');
  const locale = useLocale();
  switch (block.type) {
    case 'greeting':
      return (
        <>
          <p className={s.text}>{t('greeting.hello')}</p>
          <p className={s.text}>{t('greeting.plan')}</p>
          <p className={s.meta}>{t('greeting.d1')}</p>
          <p className={s.text}>{block.hasResume && block.resumeName ? t('greeting.withResume', { name: block.resumeName }) : t('greeting.withoutResume')}</p>
        </>
      );
    case 'resume':
      return (
        <p className={s.text}>
          {t('blocks.resumeRead', { name: block.resumeName })}{' '}
          {block.roles.length
            ? block.years
              ? t('blocks.resumeRolesYears', { roles: joinList(block.roles, locale), years: block.years })
              : t('blocks.resumeRoles', { roles: joinList(block.roles, locale) })
            : null}
        </p>
      );
    case 'learned':
      return <p className={s.meta}>{t('blocks.learned', { topics: joinList(block.topics.map((topic) => t(`brief.topics.${topic}` as never)), locale) })}</p>;
    case 'profiles':
      return (
        <div className={s.workLine}>
          <p className={s.text}>{t('blocks.profiles', { a: block.labels[0], b: block.labels[1] })}</p>
          <div className={s.actions}>
            <button type="button" className={s.textBtn} onClick={() => onOpen('profile')}>
              {t('blocks.compare')}
            </button>
          </div>
        </div>
      );
    case 'revision':
      return (
        <div className={s.workLine}>
          <p className={s.text}>
            {block.version === 1
              ? t('blocks.revisionFirst')
              : t('blocks.revision', { version: block.version, fields: joinList(block.changed.map((f) => t(`fields.${f}` as never)), locale) })}
          </p>
          <div className={s.actions}>
            <button type="button" className={s.textBtn} onClick={() => onOpen('profile')}>
              {t('blocks.seeVersion')}
            </button>
          </div>
        </div>
      );
    case 'restored':
      return <p className={s.workLine}>{t('blocks.restored', { version: block.version })}</p>;
    case 'saved':
      return (
        <div className={s.workLine}>
          <p className={s.text}>{t('blocks.saved', { name: block.name })}</p>
          <p className={s.meta}>
            {!block.search
              ? t('blocks.saved_kept')
              : isUnnamed(block.search.name) && (block.search.mode === 'updated' || block.search.mode === 'replaced')
                ? t(block.search.mode === 'updated' ? 'blocks.saved_updated_main' : 'blocks.saved_replaced_main')
                : dynamic(t)(`blocks.saved_${block.search.mode}`, { search: block.search.name })}
          </p>
        </div>
      );
    case 'matches':
      return (
        <div className={s.workLine}>
          <p className={s.text}>{t('blocks.matches', { count: block.count })}</p>
          {block.count > 0 ? (
            <div className={s.actions}>
              <button type="button" className={s.textBtn} onClick={() => onOpen('jobs')}>
                {t('blocks.seeJobs')}
              </button>
            </div>
          ) : null}
        </div>
      );
    case 'report':
      return (
        <div className={s.workLine}>
          <p className={s.text}>
            {t('blocks.reportFacts', { active: block.facts.active, waiting: block.facts.waiting, interviewing: block.facts.interviewing, offers: block.facts.offers })}
          </p>
          <div className={s.actions}>
            <button type="button" className={s.textBtn} onClick={() => onOpen('applications')}>
              {t('blocks.seeApplications')}
            </button>
          </div>
        </div>
      );
    case 'reminder': {
      const what = [block.company, block.title].filter(Boolean).join(' · ') || t('blocks.thisApplication');
      return <p className={s.workLine}>{block.date ? t('blocks.reminder', { what, date: formatDay(block.date, locale) }) : t('blocks.reminderCleared', { what })}</p>;
    }
    case 'choice':
      return (
        <div className={s.chips}>
          {block.options.map((o) => (
            <button key={o.entryId} type="button" className={s.chip} disabled={reminderBusy} onClick={() => onRemind(o.entryId, block.date)}>
              {[o.company, o.title].filter(Boolean).join(' · ') || t('blocks.thisApplication')}
            </button>
          ))}
        </div>
      );
    case 'action':
      return null;
    case 'notice':
      return (
        <p className={s.noticeLine}>
          <IconInfo size={14} />
          <span>{t(`notice.${block.code}` as never)}</span>
        </p>
      );
    default:
      return null;
  }
}

function actionText(block: Extract<AliceBlock, { type: 'action' }>, t: ReturnType<typeof useTranslations>): string {
  return dynamic(t)(`action.${block.action}`, { label: block.label ?? '', version: block.version ?? 0 });
}

export function MessageItem({ message, continued, onOpen, onRemind, reminderBusy }: MessageItemProps) {
  const t = useTranslations('alice');
  if (message.role === 'user') {
    const actions = message.blocks.filter((b): b is Extract<AliceBlock, { type: 'action' }> => b.type === 'action');
    return (
      <div className={s.user}>
        {actions.map((a, i) => (
          <span key={i} className={s.actionLine}>
            <IconCheck size={14} />
            {actionText(a, t)}
          </span>
        ))}
        {message.text ? <p className={s.bubble}>{message.text}</p> : null}
      </div>
    );
  }
  return (
    <div className={s.alice}>
      <span>{continued ? null : <AliceMark small />}</span>
      <div className={s.aliceBody}>
        {continued ? null : (
          <span className={s.aliceName}>
            Alice <span>{t('tag')}</span>
          </span>
        )}
        {message.text ? <p className={s.text}>{message.text}</p> : null}
        {message.blocks.map((block, i) => (
          <Block key={i} block={block} onOpen={onOpen} onRemind={onRemind} reminderBusy={reminderBusy} />
        ))}
      </div>
    </div>
  );
}
