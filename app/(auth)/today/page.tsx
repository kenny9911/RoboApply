// /today — the signed-in home, "the desk" (docs/agent-driven/REDESIGN.md §5):
// what waits for the user, what each agent did, the next best jobs. Renders
// inside the (auth) app shell. The body is the client component in
// components/features/today; it composes reads other areas already have and
// adds no endpoint.

import { TodayPage } from '../../../components/features/today';

export default function Page() {
  return <TodayPage />;
}
