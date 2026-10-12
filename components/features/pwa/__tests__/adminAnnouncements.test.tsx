// WP-61: /admin/announcements — admin gate, list, "translated before
// publish" in the form, draft save, and server error messages.
// Network is a fetch double; data is fictional.

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const authState = vi.hoisted(() => ({ status: 'authenticated' as const, user: { id: 'admin1', role: 'admin' } as { id: string; role: string } | null }));
vi.mock('../../../../lib/auth/useAuth', () => ({ useAuth: () => authState }));

import { BrandProvider, clientBrandFor, getBrand } from '../../../../lib/brand';
import { IntlWrapper } from '../../../../__tests__/utils/mockTranslations';
import { capsFor } from '../../../../__tests__/shell/helpers';
import { fail, installFetch, ok } from '../../filters/filters.testkit';
import type { AdminAnnouncementView } from '../../../../lib/api/contracts/announcements';
import {
  AnnouncementsAdmin,
  contentStatus,
  emptyForm,
  formFromView,
  formPayload,
  fromLocalInput,
  toLocalInput,
} from '../../../../app/(auth)/admin/announcements/AnnouncementsAdmin';

const ADM = '/api/v1/roboapply/admin/announcements';
const ROBO = getBrand('roboapply');

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <IntlWrapper>
          <BrandProvider brand={clientBrandFor('roboapply')} initialCapabilities={capsFor('roboapply', {})}>
            {children}
          </BrandProvider>
        </IntlWrapper>
      </QueryClientProvider>
    );
  }
  return render(<AnnouncementsAdmin />, { wrapper: Wrapper });
}

function view(over: Partial<AdminAnnouncementView> = {}): AdminAnnouncementView {
  return {
    id: 'a1',
    key: 'launch.assistant',
    brand: 'roboapply',
    locales: ['en'],
    content: { en: { title: 'New', body: 'Something new.' } },
    cohort: {},
    priority: 100,
    startsAt: '2026-10-10T08:00:00.000Z',
    endsAt: '2026-11-09T08:00:00.000Z',
    active: false,
    createdAt: '2026-10-10T08:00:00.000Z',
    missingLocales: ROBO.locales.filter((l) => l !== 'en'),
    status: 'draft',
    ...over,
  };
}

beforeEach(() => {
  authState.user = { id: 'admin1', role: 'admin' };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('form helpers', () => {
  it('round-trips dates and builds the request from complete languages only', () => {
    const iso = '2026-10-10T08:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeUndefined();
    const form = formFromView(view({ cohort: { plans: ['pro'], flags: ['copilot'] }, priority: 5 }));
    form.content.fr = { title: 'Nouveau', body: '', ctaLabel: '', ctaHref: '' };
    const status = contentStatus(form);
    expect(status.complete).toEqual(['en']);
    expect(status.partial).toEqual(['fr']);
    const payload = formPayload(form);
    expect(Object.keys(payload.content)).toEqual(['en']);
    expect(payload.cohort).toEqual({ plans: ['pro'], flags: ['copilot'] });
    expect(payload.priority).toBe(5);
    expect(emptyForm('goapply').locales).toEqual([...getBrand('goapply').locales]);
  });
});

describe('AnnouncementsAdmin', () => {
  it('is for administrators only', () => {
    authState.user = { id: 'u1', role: 'seeker' };
    const net = installFetch({});
    renderAdmin();
    expect(screen.getByText('This page is for administrators only.')).toBeTruthy();
    expect(net.calls).toHaveLength(0);
  });

  it('lists announcements; publishing is blocked while languages are missing', async () => {
    installFetch({ [`GET ${ADM}`]: () => ok({ items: [view(), view({ id: 'a2', key: 'all.done', active: true, status: 'live', missingLocales: [] })] }) });
    renderAdmin();
    const draft = await screen.findByTestId('announcement-launch.assistant');
    expect(within(draft).getByText('Draft')).toBeTruthy();
    expect(within(draft).getByText('8 languages missing', { exact: false })).toBeTruthy();
    expect((within(draft).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
    const live = screen.getByTestId('announcement-all.done');
    expect(within(live).getByText('Live')).toBeTruthy();
    expect(within(live).getByRole('button', { name: 'Unpublish' })).toBeTruthy();
  });

  it('saves a partial draft; "Save and publish" waits for every language', async () => {
    const net = installFetch({
      [`GET ${ADM}`]: () => ok({ items: [] }),
      [`POST ${ADM}`]: () => ok(view(), 201),
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'New announcement' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Key', { exact: false }), { target: { value: 'launch.assistant' } });
    const en = within(dialog).getByTestId('locale-en');
    fireEvent.change(within(en).getByLabelText('Title'), { target: { value: 'New' } });
    fireEvent.change(within(en).getByLabelText('Message'), { target: { value: 'Something new.' } });

    expect((within(dialog).getByRole('button', { name: 'Save and publish' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByTestId('publish-blocked').textContent).toMatch(/Add every language before publishing/);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    });
    await waitFor(() => expect(net.to('POST', ADM)).toHaveLength(1));
    expect(net.to('POST', ADM)[0]!.body).toEqual({
      key: 'launch.assistant',
      brand: 'roboapply',
      active: false,
      locales: [...ROBO.locales],
      content: { en: { title: 'New', body: 'Something new.' } },
      cohort: {},
    });
  });

  it('enables publishing once every language is filled, and shows server reasons', async () => {
    const net = installFetch({
      [`GET ${ADM}`]: () => ok({ items: [] }),
      [`POST ${ADM}`]: () => fail(409, 'conflict', { reason: 'key_taken' }),
    });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'New announcement' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Site'), { target: { value: 'goapply' } });
    expect(within(dialog).queryByTestId('locale-ja')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Key', { exact: false }), { target: { value: 'cn.note' } });
    for (const l of getBrand('goapply').locales) {
      const block = within(dialog).getByTestId(`locale-${l}`);
      fireEvent.change(within(block).getByLabelText('Title'), { target: { value: `T ${l}` } });
      fireEvent.change(within(block).getByLabelText('Message'), { target: { value: `B ${l}` } });
    }
    const publish = within(dialog).getByRole('button', { name: 'Save and publish' }) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(publish);
    });
    await waitFor(() => expect(net.to('POST', ADM)).toHaveLength(1));
    expect(net.to('POST', ADM)[0]!.body).toMatchObject({ brand: 'goapply', active: true, locales: ['zh', 'en'] });
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Another announcement already uses this key.');
  });
});
