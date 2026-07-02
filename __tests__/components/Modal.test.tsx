// Modal — solid (opaque) panel background regression check (CLAUDE.md rule).
//
// The CLAUDE.md "Modal Dialogs — Solid panel background" rule requires the
// panel itself to render fully opaque so the dim backdrop can never bleed
// through. RoboApply satisfies this with the GLOBAL, theme-aware `--surface`
// token — defined at :root + html[data-theme='light'], so it always resolves
// to an opaque #181923 (dark) / #FFFFFF (light), never the `.jb-root`-scoped
// token the rule warns about. That keeps modals readable in BOTH themes
// (hardcoding literal white would make the dark-mode title text — text-ink-900
// = near-white — invisible). A literal solid white is also accepted. This test
// guards against a transparent / empty / translucent panel.
//
// Also asserts:
//   - clicking the backdrop dismisses the modal
//   - clicking inside the panel does NOT dismiss
//   - Escape key dismisses
//   - renders nothing when open=false

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from '../../components/ui/Modal';

describe('Modal', () => {
  it('renders nothing when open=false', () => {
    render(
      <Modal open={false} onClose={() => {}}>
        Hidden contents
      </Modal>,
    );
    expect(screen.queryByText(/Hidden contents/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders panel with a solid, opaque inline background (CLAUDE.md modal solid-bg rule)', () => {
    render(
      <Modal open onClose={() => {}} title="Test">
        <p>body text</p>
      </Modal>,
    );
    // Find the inner panel (the element carrying the surface background). It's
    // the child of the outer dialog wrapper (the dialog itself is the dim
    // backdrop).
    const dialog = screen.getByRole('dialog');
    const panel = dialog.querySelector('div[style*="background"]');
    expect(panel).not.toBeNull();
    const bg = (panel as HTMLElement).style.background;
    // Must declare a background (never empty/transparent).
    expect(bg).toBeTruthy();
    // Accept the GLOBAL theme-aware surface token (always opaque #181923 / #FFF)
    // or a literal solid white. jsdom keeps `var(--surface)` verbatim and
    // normalises literal white to "#ffffff" / "rgb(255, 255, 255)".
    const opaque =
      bg === 'var(--surface)' ||
      bg === '#ffffff' ||
      bg === '#fff' ||
      bg.includes('255, 255, 255');
    expect(opaque).toBe(true);
    // Must NOT be a translucent fill — that would let the backdrop bleed
    // through (the failure mode the CLAUDE.md rule exists to prevent).
    expect(bg).not.toMatch(/rgba?\([^)]*,\s*0?\.\d+\s*\)/);
  });

  it('clicking the backdrop dismisses (calls onClose)', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Backdrop test">
        <p>inside body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the panel does NOT dismiss', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Inside test">
        <button type="button">Inside button</button>
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Inside button/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape key dismisses', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Esc test">
        <p>esc me</p>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders title and description when supplied', () => {
    render(
      <Modal open onClose={() => {}} title="Hello" description="Subtitle here">
        <p>body</p>
      </Modal>,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: /Hello/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Subtitle here/i)).toBeInTheDocument();
  });
});
