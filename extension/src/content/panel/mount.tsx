// extension/src/content/panel/mount.tsx — mounts the panel in a shadow root so
// the employer page's CSS cannot restyle it and ours cannot leak out.
// Closed shadow root in store builds; open in dev builds (Playwright e2e).

import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { Launcher } from './Launcher';
import { Panel, type PanelProps } from './Panel';
import { PANEL_CSS, clarityTokens } from './styles';

export const HOST_ID = 'ra-ext-panel-host';

export interface MountOptions extends Omit<PanelProps, 'onCollapse' | 'onRegisterRefresh'> {
  brand: 'roboapply' | 'goapply';
  dev: boolean;
  /** Start expanded (toolbar click) instead of as the launcher button. */
  open: boolean;
}

export interface MountedPanel {
  host: HTMLElement;
  open(): void;
  /**
   * The page changed under the same form (the next page of a page-by-page
   * form): the panel looks again and offers "Fill this page". No-op before
   * the panel was first opened.
   */
  refresh?(): void;
  unmount(): void;
}

/**
 * The panel is created on the first open (no API call before a user click)
 * and then stays mounted: "Hide panel" only hides it, so the fill session,
 * its Undo log and "Did you submit this application?" survive a collapse,
 * and opening it again does not start (or charge for) a new fill.
 */
function App({ initialOpen, panel, register }: { initialOpen: boolean; panel: Omit<PanelProps, 'onCollapse'>; register: (open: () => void) => void }) {
  const [open, setOpen] = useState(initialOpen);
  const [created, setCreated] = useState(initialOpen);
  const show = () => {
    setCreated(true);
    setOpen(true);
  };
  register(show);
  return (
    <div className="root" data-open={open ? 'true' : 'false'}>
      {created ? (
        <div className="panel-slot" hidden={!open}>
          <Panel {...panel} onCollapse={() => setOpen(false)} />
        </div>
      ) : null}
      {open ? null : <Launcher onOpen={show} market={panel.market} />}
    </div>
  );
}

export function mountPanel(doc: Document, opts: MountOptions): MountedPanel {
  const existing = doc.getElementById(HOST_ID);
  existing?.remove();
  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-brand', opts.brand);
  const shadow = host.attachShadow({ mode: opts.dev ? 'open' : 'closed' });
  const style = doc.createElement('style');
  style.textContent = `${clarityTokens()}\n${PANEL_CSS}`;
  shadow.appendChild(style);
  const container = doc.createElement('div');
  shadow.appendChild(container);
  (doc.body ?? doc.documentElement).appendChild(host);

  let openFn: () => void = () => {};
  let refreshFn: () => void = () => {};
  const { brand: _b, dev: _d, open, ...rest } = opts;
  const panel = { ...rest, onRegisterRefresh: (fn: () => void) => (refreshFn = fn) };
  const root: Root = createRoot(container);
  root.render(<App initialOpen={open} panel={panel} register={(fn) => (openFn = fn)} />);

  return {
    host,
    open: () => openFn(),
    refresh: () => refreshFn(),
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
