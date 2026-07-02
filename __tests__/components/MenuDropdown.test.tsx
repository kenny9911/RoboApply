// MenuDropdown — outside-click + Escape close, danger styling, submenu chevron,
// onClick fires + auto-closes for non-submenu items.

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { MenuDropdown, type MenuItem } from '../../components/resumes/MenuDropdown';

const items: MenuItem[] = [
  { id: 'a', label: 'Action A', onClick: vi.fn() },
  { id: 'b', label: 'Action B', hasSubmenu: true, onClick: vi.fn() },
  { id: 'c', label: 'Danger', danger: true, onClick: vi.fn() },
];

describe('MenuDropdown', () => {
  it('opens on trigger click and renders every item', () => {
    render(<MenuDropdown items={items} />);
    fireEvent.click(screen.getByRole('button', { name: /Menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Action A/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Danger/i })).toBeInTheDocument();
  });

  it('fires onClick and closes for a regular item', () => {
    const onClick = vi.fn();
    render(<MenuDropdown items={[{ id: 'x', label: 'Click me', onClick }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Menu/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Click me/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the menu open for items marked hasSubmenu', () => {
    const onClick = vi.fn();
    render(
      <MenuDropdown
        items={[{ id: 'x', label: 'Open submenu', hasSubmenu: true, onClick }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Menu/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Open submenu/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(<MenuDropdown items={items} />);
    fireEvent.click(screen.getByRole('button', { name: /Menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks danger items with text-danger class', () => {
    render(<MenuDropdown items={items} />);
    fireEvent.click(screen.getByRole('button', { name: /Menu/i }));
    const danger = screen.getByRole('menuitem', { name: /Danger/i });
    expect(danger.className).toMatch(/text-danger/);
  });
});
