'use client';

// JobCardStack — a horizontally scrollable stack of ≤5 recommendation cards
// emitted by one `job-cards` stream event (or rehydrated from a restored
// session). Save rides the existing `POST /v2/jobs/:id/save`; Pass hits the
// onboarding pass endpoint — both wired by the parent.

import type { OnboardingJobCard as OnboardingJobCardData } from '../../../lib/api/v2/types';
import { OnboardingJobCard } from './OnboardingJobCard';

const MAX_CARDS = 5;

interface Props {
  jobs: OnboardingJobCardData[];
  savedJobIds: string[];
  passedJobIds: string[];
  onSave: (job: OnboardingJobCardData) => void;
  onPass: (job: OnboardingJobCardData) => void;
}

export function JobCardStack({
  jobs,
  savedJobIds,
  passedJobIds,
  onSave,
  onPass,
}: Props) {
  return (
    <div
      data-testid="onboarding-job-card-stack"
      style={{
        display: 'flex',
        gap: 12,
        overflowX: 'auto',
        padding: '4px 2px 10px',
      }}
    >
      {jobs.slice(0, MAX_CARDS).map((job) => (
        <OnboardingJobCard
          key={job.id}
          job={job}
          saved={savedJobIds.includes(job.id)}
          passed={passedJobIds.includes(job.id)}
          onSave={onSave}
          onPass={onPass}
        />
      ))}
    </div>
  );
}
