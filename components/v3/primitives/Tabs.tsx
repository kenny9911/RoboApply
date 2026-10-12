'use client';

// Tabs — an accessible tab list (FND-6a; WAI-ARIA tabs pattern with manual
// activation by click and automatic activation by arrow keys).
//
//   const [tab, setTab] = useState('overview');
//   <Tabs ariaLabel="Job" value={tab} onChange={setTab}
//         tabs={[{ id: 'overview', label: 'Overview' }, { id: 'company', label: 'Company' }]} />
//   <div {...tabPanelProps('job', 'overview')} hidden={tab !== 'overview'}>…</div>
//
// Keyboard: ArrowLeft/ArrowRight move and select (wrapping), Home/End jump.
// Only the selected tab is in the Tab order. Counts render only when known
// (null/undefined draws nothing; D3).

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import styles from './primitives.module.css';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  /** A real count, or null/undefined for none. */
  count?: number | null;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  /** Prefix for tab/panel ids; defaults to the aria label. */
  idBase?: string;
  className?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tabs';

/** DOM ids shared by a tab and its panel. */
export function tabIds(idBase: string, id: string): { tab: string; panel: string } {
  const base = slug(idBase);
  return { tab: `${base}-tab-${slug(id)}`, panel: `${base}-panel-${slug(id)}` };
}

/** Props for the element that shows a tab's content. */
export function tabPanelProps(idBase: string, id: string) {
  const ids = tabIds(idBase, id);
  return { id: ids.panel, role: 'tabpanel' as const, 'aria-labelledby': ids.tab, tabIndex: 0 };
}

export function Tabs<T extends string = string>({ tabs, value, onChange, ariaLabel, idBase, className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const base = idBase ?? ariaLabel;
  const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);

  function move(from: number, delta: number | 'first' | 'last') {
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(from);
    let next: number;
    if (delta === 'first') next = enabled[0];
    else if (delta === 'last') next = enabled[enabled.length - 1];
    else next = enabled[(pos + delta + enabled.length) % enabled.length];
    refs.current[next]?.focus();
    onChange(tabs[next].id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'ArrowRight') { e.preventDefault(); move(index, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(index, -1); }
    else if (e.key === 'Home') { e.preventDefault(); move(index, 'first'); }
    else if (e.key === 'End') { e.preventDefault(); move(index, 'last'); }
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className={cn(styles.tablist, className)}>
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        const ids = tabIds(base, tab.id);
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={selected}
            aria-controls={ids.panel}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            className={styles.tab}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {tab.label}
            {typeof tab.count === 'number' && Number.isFinite(tab.count) ? (
              <span className={styles.tabCount}>{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
