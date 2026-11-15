'use client';

// TailorTab — the editor's Tailor tab: start the tailor flow (WP-36a) for the
// resume open in the editor, beside its live preview (resume.io's Tailor
// tab). It is the hub's AI tailoring panel (../hub/TailorPanel) for this one
// resume: what tailoring does (AI rewrites a copy, the original stays as it
// is), the saved jobs that have no tailored version yet (the hub's own list,
// untailoredJobs) as one-tap starts, and a button that opens the flow to pick
// another saved job or paste the posting. The flow itself is the TailorSheet,
// which the editor opens through `onTailor`.
//
// The editor lists this tab only when AI tailoring may run for this user
// (useTailorAvailability, R-04); the saved jobs are read when it first opens.

import type { ResumeSummary } from '../../../../lib/api/resumes';
import { useTailorTargets } from '../../../../hooks/tailor';
import { useResumeList } from '../../../../hooks/useResumes';
import { untailoredJobs } from '../hub/hubModel';
import { TailorPanel } from '../hub/TailorPanel';
import styles from './EditorTabs.module.css';

export interface TailorChoice {
  jobId: string;
  /** For the sheet's heading. */
  title: string;
}

export interface TailorTabProps {
  resumeId: string;
  /** Open the tailor flow for this resume: for a saved job, or (null) to pick one or paste a posting. */
  onTailor: (job: TailorChoice | null) => void;
}

export function TailorTab({ resumeId, onTailor }: TailorTabProps) {
  const list = useResumeList();
  const targets = useTailorTargets();
  const resumes: readonly ResumeSummary[] = list.data?.resumes ?? [];
  const self = resumes.find((r) => r.id === resumeId);
  const jobs = untailoredJobs(targets.data ?? [], resumes);

  return (
    <div className={styles.stack} data-panel="tailor">
      <TailorPanel
        bases={self ? [self] : []}
        baseId={resumeId}
        onBaseChange={() => undefined}
        jobs={jobs}
        actionVariant="default"
        onTailor={(jobId) => {
          const job = jobId ? jobs.find((j) => j.jobId === jobId) : null;
          onTailor(job ? { jobId: job.jobId, title: job.title } : null);
        }}
      />
    </div>
  );
}
