'use client';

// /assistant — the Assistant, full page (PRODUCT_PLAN.md §3.4; F-ORION-01;
// TASK_PLAN.md WP-51). On a phone this is the full-screen Assistant. The page
// lives in components/features/copilot/AssistantPage.tsx.
//
// `useSearchParams` (?thread, ?job) needs a Suspense boundary in the App Router.

import { Suspense } from 'react';

import { AssistantPage } from '../../../components/features/copilot';

export default function AssistantRoute() {
  return (
    <Suspense fallback={null}>
      <AssistantPage />
    </Suspense>
  );
}
