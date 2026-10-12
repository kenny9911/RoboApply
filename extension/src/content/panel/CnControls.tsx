// extension/src/content/panel/CnControls.tsx — the GoApply pieces of the panel
// (一键填表): the three fill modes, the review line after a fill with the
// portal's own submit control outlined, and the AI label in the
// AiGeneratedBadge style. Strings: the `extension-cn` namespace (cnStrings.ts).
//
// D1: "填写选中区域" reads the user's selection; "定位提交按钮" only scrolls the
// page to the portal's button. Nothing here presses anything on the page.

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import type { AtsAdapter } from '../../adapters/types';
import type { FillMode } from '../fill';
import { cnText } from './cnStrings';
import { findSubmitControl, outlineSubmitControl, revealSubmitControl } from './submitHint';

export type InScope = (el: Element) => boolean;

/**
 * The user's current selection on the page as a membership test, or null when
 * nothing is selected. Ranges are copied, so later clicks cannot change them.
 */
export function captureSelection(doc: Document): InScope | null {
  const sel = doc.getSelection?.();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
  return (el) => ranges.some((r) => {
    try {
      return r.intersectsNode(el);
    } catch {
      return false;
    }
  });
}

const MODES: readonly FillMode[] = ['all', 'blank', 'selection'];

export function CnFillModes({ doc, again, disabled, onStart }: { doc: Document; again: boolean; disabled?: boolean; onStart: (mode: FillMode, inScope: InScope | null) => void }) {
  // Taken when the pointer goes down, before the click can move focus or the selection.
  const captured = useRef<InScope | null>(null);
  const hold = (e: ReactMouseEvent) => {
    e.preventDefault();
    captured.current = captureSelection(doc);
  };
  const start = (mode: FillMode) => {
    const inScope = mode === 'selection' ? (captured.current ?? captureSelection(doc)) : null;
    captured.current = null;
    onStart(mode, inScope);
  };
  return (
    <div className="modes" role="group" aria-labelledby="ra-cn-modes">
      <p className="strong" id="ra-cn-modes">
        {again ? cnText('modes.again') : cnText('modes.heading')}
      </p>
      {MODES.map((mode) => (
        <div className="mode" key={mode}>
          <button
            type="button"
            className={mode === 'all' && !again ? 'btn primary' : 'btn'}
            disabled={disabled}
            data-mode={mode}
            onMouseDown={mode === 'selection' ? hold : undefined}
            onClick={() => start(mode)}
          >
            {cnText(`modes.${mode}`)}
          </button>
          <p className="meta muted">{cnText(`modes.${mode}Hint`)}</p>
        </div>
      ))}
      <p className="meta muted">{cnText('modes.cost')}</p>
    </div>
  );
}

/**
 * "请核对后自行提交": shown when a fill is done. Outlines the portal's own
 * submit control while the panel is mounted and offers to scroll to it.
 */
export function CnReviewHint({ doc, adapter, fillKey }: { doc: Document; adapter: AtsAdapter; fillKey: number }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = findSubmitControl(doc, adapter);
    setTarget(el);
    if (!el) return;
    const restore = outlineSubmitControl(el);
    return restore;
  }, [doc, adapter, fillKey]);
  return (
    <div className="review" role="status">
      <p className="strong">{cnText('review.title')}</p>
      <p className="meta">{target ? cnText('review.found') : cnText('review.notFound')}</p>
      {target ? (
        <div className="row">
          <button type="button" className="btn" onClick={() => revealSubmitControl(target)}>
            {cnText('review.show')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The AI label on GoApply, in the web app's AiGeneratedBadge style (sparkle + "AI 辅助生成"). */
export function CnAiBadge() {
  return (
    <span className="chip ai-badge" data-kind="ai" data-ai-label="text">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6L8 1.5z" fill="currentColor" />
      </svg>
      {cnText('aiBadge')}
    </span>
  );
}

/** Notes and errors the `extension-cn` namespace words (the rest stay in `extension`). */
export const CN_NOTES: ReadonlySet<string> = new Set(['has_value', 'personal', 'family_none', 'sensitive_consent', 'other_person', 'check_whose', 'photo']);
export const CN_ERRORS: ReadonlySet<string> = new Set(['no_selection', 'no_fields_in_selection']);
