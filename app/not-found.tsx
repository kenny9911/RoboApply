// The 404 page: an unmatched URL, or notFound() with no closer not-found file.
//
// It renders inside the root layout, so the page body (a client component)
// has the providers the layout mounts: the reader's language and the session.
// The body does not depend on them — see components/v3/shell/errorCopy.ts —
// so this file stays free of cookies(), headers() and anything else that
// would tie the 404 to a request.

import { NotFoundView } from '../components/v3/shell/NotFoundView';

export default function NotFound() {
  return <NotFoundView />;
}
