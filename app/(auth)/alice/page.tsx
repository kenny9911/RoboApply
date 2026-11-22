'use client';

// /alice — Alice, the application agent (docs/alice/ALICE.md). The page lives
// in components/features/alice/AlicePage.tsx; it renders inside the (auth) app
// shell. Shown with the `alice` capability (the nav entry carries the flag;
// the API answers 404 feature_disabled when it is off).

import { AlicePage } from '../../../components/features/alice';

export default function AliceRoute() {
  return <AlicePage />;
}
