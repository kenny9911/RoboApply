// extension/src/content/panel/styles.ts — the panel's CSS, inside its shadow root.
//
// Clarity tokens (app/globals.css + styles/brands/goapply.css) are copied in at
// build time (scripts/tokens.mjs → __CLARITY_TOKENS__), rescoped to :host, with
// dark mode following the visitor's system setting and GoApply's brand tokens
// under :host([data-brand="goapply"]). The rules below use tokens only.

declare const __CLARITY_TOKENS__: string | undefined;

export function clarityTokens(): string {
  return typeof __CLARITY_TOKENS__ !== 'undefined' && __CLARITY_TOKENS__ ? __CLARITY_TOKENS__ : '';
}

export const PANEL_CSS = `
:host { all: initial; }
.root, .root * { box-sizing: border-box; }
.root [hidden] { display: none !important; }
.root {
  position: fixed; z-index: 2147483646; top: var(--sp-4); right: var(--sp-4);
  font-family: var(--font-ui); font-size: var(--fs-body); line-height: var(--lh-body);
  letter-spacing: var(--ls-body); color: var(--text); -webkit-font-smoothing: antialiased;
}
.launcher {
  display: inline-flex; align-items: center; gap: var(--sp-2); min-height: var(--control-lg);
  padding: 0 var(--sp-4); border: 0; border-radius: var(--r-pill); cursor: pointer;
  background: var(--grad-brand); color: var(--action-ink); font: inherit; font-weight: 600;
  box-shadow: var(--e2);
}
.launcher:hover { background: var(--grad-brand-hover); }
.panel {
  width: min(384px, calc(100vw - 2 * var(--sp-4))); max-height: calc(100vh - 2 * var(--sp-4));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); border: 1px solid var(--rule); border-radius: var(--r-lg); box-shadow: var(--e3);
}
.head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-4) var(--sp-3); background: var(--grad-soft); border-bottom: 1px solid var(--rule);
}
.title { margin: 0; font-size: var(--fs-subtitle); line-height: var(--lh-subtitle); letter-spacing: var(--ls-subtitle); font-weight: 650; }
.meta { margin: 0; color: var(--text-2); font-size: var(--fs-meta); line-height: var(--lh-meta); }
.muted { color: var(--text-muted); }
.body { padding: var(--sp-4); overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-4); }
.card { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--surface-2); }
.job-title { margin: 0; font-weight: 600; }
.fit { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); margin-top: var(--sp-2); }
.tier { font-weight: 650; color: var(--action); }
.tier[data-tier="great"] { color: var(--brand-plane); }
.chip {
  display: inline-flex; align-items: center; min-height: 24px; padding: 0 var(--sp-2);
  border-radius: var(--r-pill); font-size: var(--fs-label); letter-spacing: var(--ls-label); font-weight: 600;
  background: var(--surface-3); color: var(--text-2);
}
.chip[data-status="filled"] { background: var(--ok-subtle); color: var(--ok); }
.chip[data-status="needs_you"] { background: var(--warn-subtle); color: var(--warn); }
.chip[data-kind="ai"] { background: var(--action-subtle); color: var(--action); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
  min-height: var(--control-lg); min-width: var(--control-lg); padding: 0 var(--sp-4);
  border-radius: var(--r-md); border: 1px solid var(--rule-strong); background: var(--surface); color: var(--text);
  font: inherit; font-weight: 600; cursor: pointer; text-decoration: none;
  transition: background var(--dur-hover) var(--ease-out);
}
.btn:hover { background: var(--surface-2); }
.btn:focus-visible, .launcher:focus-visible, textarea:focus-visible, input:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.btn[disabled] { color: var(--disabled); cursor: default; }
.btn.primary { border: 0; background: var(--grad-brand); color: var(--action-ink); width: 100%; }
.btn.primary:hover { background: var(--grad-brand-hover); }
.btn.quiet { border-color: transparent; background: transparent; color: var(--action); padding: 0 var(--sp-2); }
.row { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.item { padding: var(--sp-3); border: 1px solid var(--rule); border-radius: var(--r-md); display: flex; flex-direction: column; gap: var(--sp-2); }
.item[data-sensitive="true"] { border-color: var(--warn); }
.item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-2); }
.item-label { margin: 0; font-size: var(--fs-meta); line-height: var(--lh-meta); font-weight: 600; overflow-wrap: anywhere; }
.draft { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border-radius: var(--r-sm); background: var(--action-subtle); }
textarea {
  width: 100%; min-height: 96px; padding: var(--sp-2) var(--sp-3); resize: vertical;
  border: 1px solid var(--rule-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text); font: inherit;
}
.modes { display: flex; flex-direction: column; gap: var(--sp-2); }
.mode { display: flex; flex-direction: column; gap: var(--sp-1); }
.mode .btn { width: 100%; }
.review { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border-radius: var(--r-md); background: var(--action-subtle); }
.ai-badge { gap: var(--sp-1); }
.ai-badge svg { flex: none; }
.notice { margin: 0; padding: var(--sp-3); border-radius: var(--r-md); background: var(--warn-subtle); color: var(--warn); font-size: var(--fs-meta); }
.foot { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--rule); }
.strong { font-weight: 650; margin: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 520px) {
  .root { top: auto; right: 0; left: 0; bottom: 0; }
  .root[data-open="false"] { left: auto; right: var(--sp-4); bottom: var(--sp-4); }
  .panel { width: 100vw; max-height: 85vh; border-radius: var(--r-lg) var(--r-lg) 0 0; border-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
`;
