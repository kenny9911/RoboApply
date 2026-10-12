'use client';

// ThemeBootScript — the no-flash theme bootstrap for the root layout's <head>.
//
// It reads the persisted theme (lib/theme.tsx, STORAGE_KEY
// 'roboapply:theme:v4') and sets data-theme + color-scheme on <html> before
// the first paint, so the right palette is live on the very first frame. Only
// 'light' and 'dark' are valid. Keep the storage key and the `theme` field in
// sync with lib/theme.tsx (ThemeBootScript.test.tsx checks the key).
//
// Why this is a component and not a bare <script> in app/layout.tsx:
//
// A 404 (an unmatched URL, or notFound() in a page) is not server-rendered by
// Next 16 — the response is an empty `<html id="__next_error__">` shell and the
// whole document, root layout included, is rendered in the browser. React
// never executes a <script> it creates in the browser, and in development it
// says so: "Encountered a script tag while rendering React component", once
// per 404, in every locale and on both brands.
//
// So the script is only an executable script where it can execute:
//   • on the server it renders as a plain inline <script> (runs, blocks paint);
//   • in the browser it renders as a data block (`type="text/plain"`), which is
//     honest — it will not run — and React has nothing to warn about. The
//     ThemeProvider applies the theme on mount in that case.
// Hydration sees the server's executable script against the browser's data
// block; `suppressHydrationWarning` covers that one attribute, and React keeps
// the server's element (it has already run).

export const THEME_BOOT_SCRIPT =
  "(function(){try{var s=localStorage.getItem('roboapply:theme:v4');var t='light';if(s){var p=JSON.parse(s);if(p&&(p.theme==='light'||p.theme==='dark'))t=p.theme;}var d=document.documentElement;d.setAttribute('data-theme',t);d.style.colorScheme=t;}catch(e){}})();";

export function ThemeBootScript() {
  const onServer = typeof window === 'undefined';
  return (
    <script
      type={onServer ? undefined : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
    />
  );
}
