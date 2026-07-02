// lib/mockInterview/store.ts
//
// Local-storage backed store for the Mock Interview surface. The V2 backend
// hasn't shipped these endpoints yet — until it does, we keep:
//   - custom mocks the user authored
//   - in-flight + completed sessions (transcripts)
//   - generated reports
//
// in localStorage. Same lookup keys + JSON shapes the real API will return,
// so the swap is a one-line change in the hook layer.
//
// All getters return fresh copies (structuredClone) so callers can mutate
// without leaking state back into storage. All setters write through.

import type { MockInterview, MockReport, MockSession } from './types';

const NS = 'roboapply:mock-interview:v1';

interface StoreShape {
  customMocks: MockInterview[];
  sessions: Record<string, MockSession>;
  reports: Record<string, MockReport>;
}

function emptyStore(): StoreShape {
  return { customMocks: [], sessions: {}, reports: {} };
}

function safeWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

function readStore(): StoreShape {
  const w = safeWindow();
  if (!w) return emptyStore();
  try {
    const raw = w.localStorage.getItem(NS);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw);
    return {
      customMocks: parsed?.customMocks ?? [],
      sessions: parsed?.sessions ?? {},
      reports: parsed?.reports ?? {},
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(s: StoreShape) {
  const w = safeWindow();
  if (!w) return;
  try {
    w.localStorage.setItem(NS, JSON.stringify(s));
  } catch {
    // best-effort
  }
}

export const mockStore = {
  listCustomMocks(): MockInterview[] {
    return structuredClone(readStore().customMocks);
  },
  saveCustomMock(mock: MockInterview): void {
    const s = readStore();
    const idx = s.customMocks.findIndex((m) => m.id === mock.id);
    if (idx >= 0) s.customMocks[idx] = mock;
    else s.customMocks.unshift(mock);
    writeStore(s);
  },
  deleteCustomMock(id: string): void {
    const s = readStore();
    s.customMocks = s.customMocks.filter((m) => m.id !== id);
    writeStore(s);
  },
  getCustomMock(id: string): MockInterview | null {
    const found = readStore().customMocks.find((m) => m.id === id);
    return found ? structuredClone(found) : null;
  },
  saveSession(session: MockSession): void {
    const s = readStore();
    s.sessions[session.id] = session;
    writeStore(s);
  },
  getSession(id: string): MockSession | null {
    const found = readStore().sessions[id];
    return found ? structuredClone(found) : null;
  },
  saveReport(report: MockReport): void {
    const s = readStore();
    s.reports[report.id] = report;
    writeStore(s);
  },
  getReport(id: string): MockReport | null {
    const found = readStore().reports[id];
    return found ? structuredClone(found) : null;
  },
  /** Most-recent report for a given mock — used to show a "previous score" on
   *  the mock card and a "view last report" link. */
  latestReportForMock(mockId: string): MockReport | null {
    const reports = Object.values(readStore().reports).filter(
      (r) => r.mockId === mockId,
    );
    if (reports.length === 0) return null;
    reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return structuredClone(reports[0]);
  },
};
