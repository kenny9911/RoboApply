// The time zone every client-formatted time uses (verify finding FIX-1 #3).
//
// <Providers> used to hand next-intl `brand.defaultTimezone` — UTC on
// RoboApply — so a viewer in UTC+8 read "More on Oct 11" when it already was
// Oct 11, and "Checked Oct 10, 6:08 PM" for a check they ran at 02:08 on the
// 11th. The viewer's own zone is the right one; the brand default stays as the
// server-render value (the server cannot know the browser's zone) and as the
// fallback when the browser will not say.

import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { useFormatter, useTimeZone } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The session loader is not what is under test, and it would call the API.
vi.mock('../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { clientBrandFor } from '../lib/brand/client';
import { Providers, resetViewerTimeZoneForTests, viewerTimeZone } from './providers';

const ROBOAPPLY = clientBrandFor('roboapply');
const GOAPPLY = clientBrandFor('goapply');

/** 18:08 UTC on Oct 10 = 02:08 on Oct 11 in Asia/Shanghai = 11:08 on Oct 10 in Los Angeles. */
const CHECKED_AT = new Date('2026-10-10T18:08:00.000Z');

function Stamp() {
  const format = useFormatter();
  const zone = useTimeZone();
  return (
    <p data-testid="stamp" data-zone={zone}>
      {format.dateTime(CHECKED_AT, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })}
    </p>
  );
}

const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

/** Make the "browser" report `zone` for a formatter built without an explicit zone. */
function browserZoneIs(zone: string | undefined) {
  const systemZone = realResolvedOptions.call(new Intl.DateTimeFormat()).timeZone;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    const real = realResolvedOptions.call(this);
    // Only the system default is replaced; a formatter given a zone keeps it.
    return real.timeZone === systemZone ? { ...real, timeZone: zone as string } : real;
  });
  resetViewerTimeZoneForTests();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetViewerTimeZoneForTests();
});

describe('viewerTimeZone', () => {
  it("is the browser's zone", () => {
    browserZoneIs('Asia/Shanghai');
    expect(viewerTimeZone()).toBe('Asia/Shanghai');
  });

  it('is null when the browser gives nothing usable', () => {
    browserZoneIs(undefined);
    expect(viewerTimeZone()).toBeNull();
    browserZoneIs('Etc/Unknown');
    expect(viewerTimeZone()).toBeNull();
    browserZoneIs('Not/AZone');
    expect(viewerTimeZone()).toBeNull();
  });
});

describe('<Providers> time zone', () => {
  it("formats in the viewer's zone, not the brand default", () => {
    browserZoneIs('Asia/Shanghai');
    render(
      <Providers locale="en" messages={{}} brand={ROBOAPPLY}>
        <Stamp />
      </Providers>,
    );
    expect(ROBOAPPLY.defaultTimezone).toBe('UTC');
    expect(screen.getByTestId('stamp')).toHaveAttribute('data-zone', 'Asia/Shanghai');
    expect(screen.getByTestId('stamp')).toHaveTextContent('Oct 11, 02:08');
  });

  it('follows the viewer on GoApply too (a viewer outside China)', () => {
    browserZoneIs('America/Los_Angeles');
    render(
      <Providers locale="en" messages={{}} brand={GOAPPLY}>
        <Stamp />
      </Providers>,
    );
    expect(GOAPPLY.defaultTimezone).toBe('Asia/Shanghai');
    expect(screen.getByTestId('stamp')).toHaveTextContent('Oct 10, 11:08');
  });

  it('falls back to the brand default when the browser does not report a zone', () => {
    browserZoneIs(undefined);
    render(
      <Providers locale="en" messages={{}} brand={GOAPPLY}>
        <Stamp />
      </Providers>,
    );
    expect(screen.getByTestId('stamp')).toHaveAttribute('data-zone', 'Asia/Shanghai');
    expect(screen.getByTestId('stamp')).toHaveTextContent('Oct 11, 02:08');
  });

  it('server-renders in the brand zone and switches after hydration without a mismatch', async () => {
    browserZoneIs('Asia/Shanghai');
    const tree = (
      <Providers locale="en" messages={{}} brand={ROBOAPPLY}>
        <Stamp />
      </Providers>
    );

    // The server has no browser to ask.
    const html = renderToString(tree);
    expect(html).toContain('data-zone="UTC"');
    expect(html).toContain('Oct 10, 18:08');

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree);
    });

    const stamp = container.querySelector('[data-testid="stamp"]')!;
    expect(stamp.getAttribute('data-zone')).toBe('Asia/Shanghai');
    expect(stamp.textContent).toBe('Oct 11, 02:08');
    const hydrationErrors = errors.mock.calls.filter((call) => /hydrat|did not match/i.test(call.map(String).join(' ')));
    expect(hydrationErrors).toEqual([]);

    await act(async () => root?.unmount());
    container.remove();
  });
});
