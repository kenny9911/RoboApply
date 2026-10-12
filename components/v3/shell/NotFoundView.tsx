'use client';

// NotFoundView — the body of app/not-found.tsx.
//
// A client component because both things it needs live on the client: the
// words (already translated in every bundle — errorCopy.ts says where — from
// the NextIntlClientProvider the root layout mounts) and whether there is a session. A visitor gets the home
// page; "Go to Jobs" would only walk them into the sign-in page. A signed-in
// user gets their jobs first and the home page second.
//
// Everything is read through errorCopy.ts, so this still renders — in English —
// if Next shows the 404 outside the providers.

import Link from 'next/link';

import { useErrorCopy, useIsSignedIn } from './errorCopy';
import { errorPageStyles as s } from './errorPage.styles';

export function NotFoundView() {
  const copy = useErrorCopy();
  const signedIn = useIsSignedIn();

  return (
    <main style={s.wrap}>
      <div style={s.card}>
        <h1 style={s.title}>{copy('not_found_title')}</h1>
        <p style={s.body}>{copy('not_found_body')}</p>
        <div style={s.actions}>
          {signedIn ? (
            <Link href="/jobs" style={s.primary}>
              {copy('go_home')}
            </Link>
          ) : null}
          <Link href="/" style={signedIn ? s.ghost : s.primary}>
            {copy('go_site_home')}
          </Link>
        </div>
      </div>
    </main>
  );
}
