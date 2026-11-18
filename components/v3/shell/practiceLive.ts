// Which /practice paths are the live interview room (full screen, no shell).
// Its own module so the (auth) layout and the shells can ask without
// importing the app frame.

/**
 * Static routes that sit beside /practice/[id] (Next.js matches them before
 * the dynamic segment), so they are pages with the shell, not live rooms.
 */
const PRACTICE_STATIC_SEGMENTS = new Set(['questions']);

/** /practice/[id] is the live room (full screen); its setup and report keep the shell. */
export function isPracticeLivePath(pathname: string): boolean {
  const m = /^\/practice\/([^/]+)\/?$/.exec(pathname);
  return !!m && !PRACTICE_STATIC_SEGMENTS.has(m[1]) && !pathname.endsWith('/report') && !pathname.includes('/custom/');
}
