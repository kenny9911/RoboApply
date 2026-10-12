// /ready/setup — Ready to apply setup (WP-53; PRODUCT F-AGENT-02): profile,
// check your search, application answers, weekly settings, extension.
// Steps are addressable by hash (#answers is linked from /profile).

import { SetupWizard } from '../../../../components/features/agent';

export default function ReadySetupPage() {
  return <SetupWizard />;
}
