'use client';

// ActivityEntry — one row in the activity timeline (.log-entry). Three columns:
//
//   [time]   mono timestamp, formatted from the ISO `at` client-side
//   [body]   the agent's receipt — MARKDOWN, rendered via the sanitized
//            Markdown primitive (NEVER raw — bodies carry **bold** company
//            names + reasoning clauses from the LLM)
//   [meta]   right-aligned mono note; when it contains "saved" it renders as
//            the green pill (proto behaviour)
//
// The entry's `kind` (success | action | note | violet) drives the timeline
// dot colour via the `.log-entry.<kind>` CSS in styles/v3.css.

import { useEffect, useState } from 'react';
import { Markdown } from '../primitives';
import type { RAActivityEntry } from '../../../lib/api/v2';

interface Props {
  entry: RAActivityEntry;
}

/** Format an ISO timestamp to a short local time, e.g. "11:42 AM". Rendered
 *  client-side only (a stable placeholder first) to avoid SSR hydration drift
 *  from locale/timezone differences — mirrors the Today clock pattern. */
function useLocalTime(iso: string): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    setLabel(
      new Date(iso).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  }, [iso]);
  return label;
}

export function ActivityEntry({ entry }: Props) {
  const time = useLocalTime(entry.at);
  const meta = entry.meta;
  const isSaved = !!meta && meta.toLowerCase().includes('saved');

  return (
    <div className={`log-entry ${entry.kind}`}>
      <div className="log-time">{time || ' '}</div>
      <div className="log-content">
        <Markdown>{entry.bodyMarkdown}</Markdown>
      </div>
      <div className="log-meta">
        {meta ? isSaved ? <span className="saved">{meta}</span> : meta : null}
      </div>
    </div>
  );
}
