// Activity-log components. CURRENTLY UNMOUNTED — nothing imports these today.
//
// They rendered `/activity`, which is not one of the four destinations (ruling
// D2). That route is deleted: `next.config.mjs` 308s `/activity` (and
// `/insights`) to `/applications`, because both answered the same question —
// "what happened to my applications?" — and the answer belongs where the
// applications are. The page file survived the route move for a while and was
// unreachable the whole time, since redirects() is evaluated before filesystem
// routing.
//
// They are kept, not deleted, because ruling C40 gives this content its next
// home rather than retiring it: the weekly insight becomes the top card of
// `/applications?view=date`, and the day-grouped receipts feed is the body of
// that view. The copy is already waiting under `applications.activity.*` and
// `applications.insight.*` in all nine locale bundles, and `hooks/useActivity`
// still serves the data.
//
// So: if you are building the `By date` view on /applications, start here. If
// you are cleaning up dead code and this note is still true a release later,
// that view was abandoned — delete this directory and those two i18n groups
// with it, rather than leaving three orphans that each look intentional.
//
// Built on the shared V3 primitives; data via hooks/useActivity
// (activity.feed + activity.orbStats).

export { ActivityStatStrip } from './ActivityStatStrip';
export { ActivityTimeline } from './ActivityTimeline';
export { ActivityEntry } from './ActivityEntry';
