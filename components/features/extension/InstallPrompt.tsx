'use client';

// InstallPrompt — "Get the extension" prompt (F-EXT; WP-55a), mounted once by
// the app shell as a popup slot and reused inline by Ready to apply (WP-53).
//
// STUB (FND-6a). Owner: WP-55a. Renders nothing. When filled, the popup mode
// must ask `requestPopup('extension:install', 'extension_prompt')`
// (lib/ui/popupGate.ts) and show only after real use; never on GoApply's
// WeChat webview (show the "open in browser" guidance instead).

export interface InstallPromptProps {
  /** 'popup' = the shell slot (gated by popupGate); 'inline' = a card inside a page. */
  mode?: 'popup' | 'inline';
}

export function InstallPrompt(_props: InstallPromptProps = {}): null {
  return null;
}

export default InstallPrompt;
