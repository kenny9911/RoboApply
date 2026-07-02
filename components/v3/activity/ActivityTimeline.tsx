'use client';

// ActivityTimeline — the dashed-rule receipts feed (.log). Renders the
// day-grouped activity: for each day a mono date pill (.log-day .pill) followed
// by its entries (ActivityEntry ×N). Pure presentation — the page owns the
// loading / empty / error states; this only draws a non-empty, grouped feed.
//
// Day labels (`day.label`, e.g. "Today · Thu, May 26") come from the data layer
// as display strings, not authored copy — rendered verbatim. Entry bodies are
// markdown (sanitized inside ActivityEntry).

import { ActivityEntry } from './ActivityEntry';
import type { RAActivityDay } from '../../../lib/api/v2';

interface Props {
  days: RAActivityDay[];
}

export function ActivityTimeline({ days }: Props) {
  return (
    <div className="log">
      {days.map((day) => (
        <div key={day.dateUtc}>
          <div className="log-day">
            <span className="pill">{day.label}</span>
          </div>
          {day.entries.map((entry) => (
            <ActivityEntry key={entry.id} entry={entry} />
          ))}
        </div>
      ))}
    </div>
  );
}
