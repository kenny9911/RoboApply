// extension/src/popup/styles.ts — toolbar popup CSS (Clarity tokens, rescoped to :root at build time).

declare const __CLARITY_TOKENS_ROOT__: string | undefined;

export function popupTokens(): string {
  return typeof __CLARITY_TOKENS_ROOT__ !== 'undefined' && __CLARITY_TOKENS_ROOT__ ? __CLARITY_TOKENS_ROOT__ : '';
}

export const POPUP_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { width: 340px; font-family: var(--font-ui); font-size: var(--fs-body); line-height: var(--lh-body); }
.wrap { padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
h1 { margin: 0; font-size: var(--fs-subtitle); line-height: var(--lh-subtitle); font-weight: 650; }
p { margin: 0; }
.meta { color: var(--text-2); font-size: var(--fs-meta); line-height: var(--lh-meta); }
.muted { color: var(--text-muted); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-lg);
  padding: 0 var(--sp-4); border-radius: var(--r-md); border: 1px solid var(--rule-strong);
  background: var(--surface); color: var(--text); font: inherit; font-weight: 600; cursor: pointer;
}
.btn:hover { background: var(--surface-2); }
.btn.primary { border: 0; background: var(--grad-brand); color: var(--action-ink); width: 100%; }
.btn.primary:hover { background: var(--grad-brand-hover); }
.btn.quiet { border-color: transparent; background: transparent; color: var(--action); }
.btn[disabled] { color: var(--disabled); cursor: default; }
.btn:focus-visible, input:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.card { padding: var(--sp-3); border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--surface); display: flex; flex-direction: column; gap: var(--sp-2); }
label { font-size: var(--fs-meta); font-weight: 600; }
input {
  width: 100%; min-height: var(--control-lg); padding: 0 var(--sp-3); border: 1px solid var(--rule-strong);
  border-radius: var(--r-sm); background: var(--surface); color: var(--text); font: inherit; letter-spacing: 0.12em; text-transform: uppercase;
}
.notice { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--warn-subtle); color: var(--warn); font-size: var(--fs-meta); }
.row { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; justify-content: space-between; }
.chip {
  display: inline-flex; align-items: center; min-height: 24px; padding: 0 var(--sp-2); margin-left: var(--sp-2);
  border-radius: var(--r-pill); font-size: var(--fs-label); letter-spacing: var(--ls-label); font-weight: 600;
  background: var(--surface-3); color: var(--text-2);
}
.chip[data-kind="ai"] { background: var(--action-subtle); color: var(--action); }
`;
