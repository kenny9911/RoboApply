// /dashboard — the signed-in home (the first nav entry on both brands, so the
// logo and the post-login redirect land here). A goal dashboard after
// resume.io's app (docs/resume-io/TEARDOWN.md): goal tabs, a progress card
// and one call to action per step, then the user's job matches. Renders
// inside the (auth) app shell; the content is components/features/dashboard.
//
// The selection lives in the query string (`?goal=&step=`), read with
// useSearchParams, so the page sits under Suspense for static rendering.

import { Suspense } from 'react';

import { Dashboard } from '../../../components/features/dashboard';

export default function DashboardRoute() {
  return (
    <Suspense fallback={null}>
      <Dashboard />
    </Suspense>
  );
}
