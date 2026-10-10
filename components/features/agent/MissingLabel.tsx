'use client';

// MissingLabel — the name of a profile detail that is still empty ("First
// name", "Phone number"), as the setup step and the kit review list it.
//
// The server sends each missing field as `{ key, label }` where `label` is an
// i18n key (`profile.missing.firstName`, server/src/features/profile/
// completeness.ts `missingLabelKey`), so the words are the reader's language.
// It is translated HERE, in one place: the kit review used to print the key
// itself. A label that is not a key of the loaded messages (an older row, a
// plain text from another source) is shown as it is.

import { useTranslations } from 'next-intl';

const KEY_SHAPE = /^[\w-]+(\.[\w-]+)+$/;

/** The words for a missing field: its translation when `label` is a message key, else `label`. */
export function useMissingLabel(): (label: string) => string {
  const t = useTranslations();
  return (label: string) => (KEY_SHAPE.test(label) && t.has(label) ? t(label) : label);
}

export function MissingLabel({ label, className }: { label: string; className?: string }) {
  const text = useMissingLabel()(label);
  return <span className={className}>{text}</span>;
}
