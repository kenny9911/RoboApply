'use client';

// TodayPage — /today, the signed-in home (docs/agent-driven/REDESIGN.md §5):
// what waits for the user, what each agent did, the next best jobs.
//
// This file only gathers the reads. Every one of them belongs to another area
// (hooks/today/useTodaySources.ts lists them); Today adds no endpoint. The
// main resume's latest check is read here, as the /resume hub does, because
// which resume is the main one is the hub's rule.

import { useLatestResumeCheck } from '../../../hooks/resume/useResumeCheck';
import { useTodaySources } from '../../../hooks/today';
import { checkStateOf, mainResumeOf, sortBases } from '../resume';
import { TodayDesk } from './TodayDesk';

export function TodayPage() {
  const sources = useTodaySources();
  const main = sources.resumes.status === 'ready' ? mainResumeOf(sortBases(sources.resumes.data)) : null;
  const latest = useLatestResumeCheck(main?.id);
  return <TodayDesk sources={sources} check={main ? checkStateOf(latest) : null} />;
}
