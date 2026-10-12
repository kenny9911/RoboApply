// WP-38: the web column model matches the server ladders, folds legacy and
// terminal statuses into the right columns, and names every status.

import { describe, expect, it } from 'vitest';

import { INTL_TRACKER_LADDER } from '../../../server/src/features/tracker/stages';
import { CN_TRACKER_LADDER } from '../../../server/src/features/cn/tracker/ladder';
import { ALL_TRACKER_STATUSES } from '../../../server/src/features/tracker/contract';
import enMessages from '../../../i18n/messages/en.json';
import staging from '../../../i18n/staging/applications.en.json';
import { CN_COLUMNS, INTL_COLUMNS, columnIndexForStatus, columnsFor, isInProgress, stageLabelKey } from './columns';

type ColumnsBundle = { applications: { columns?: Record<string, string> } };
// en.json carries the column labels (WP-91 merged the staged ones); a label staged since is read on top.
const labels: Record<string, string> = { ...(enMessages as ColumnsBundle).applications.columns, ...(staging as ColumnsBundle).applications.columns };

describe('pipeline columns', () => {
  it('match the server ladders (RoboApply C1, GoApply cn)', () => {
    expect(INTL_COLUMNS.map((c) => c.status)).toEqual([...INTL_TRACKER_LADDER]);
    expect(CN_COLUMNS.map((c) => c.status)).toEqual([...CN_TRACKER_LADDER]);
    expect(columnsFor('cn')).toBe(CN_COLUMNS);
    expect(columnsFor('intl')).toBe(INTL_COLUMNS);
  });

  it('place every stored status in exactly one column on both brands', () => {
    for (const columns of [INTL_COLUMNS, CN_COLUMNS]) {
      for (const s of ALL_TRACKER_STATUSES) {
        expect(columnIndexForStatus(s, columns), s).not.toBeNull();
        expect(columns.filter((c) => c.members.includes(s)).length, s).toBe(1);
      }
    }
    expect(columnIndexForStatus('applying')).toBe(1);
    expect(INTL_COLUMNS[columnIndexForStatus('closed')!]!.terminal).toBe(true);
    expect(columnIndexForStatus('submitted')).toBeNull();
  });

  it('name every status with a label that exists', () => {
    for (const columns of [INTL_COLUMNS, CN_COLUMNS]) {
      for (const s of ALL_TRACKER_STATUSES) expect(labels[stageLabelKey(s, columns)], s).toBeTruthy();
    }
    expect(stageLabelKey('withdrawn')).toBe('withdrawn');
    expect(stageLabelKey('negotiating')).toBe('offer');
  });

  it('ended applications are not in progress', () => {
    expect(['rejected', 'withdrawn', 'closed'].map(isInProgress)).toEqual([false, false, false]);
    expect(isInProgress('first_call')).toBe(true);
  });
});
