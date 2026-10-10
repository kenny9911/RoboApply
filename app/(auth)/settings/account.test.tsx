// /settings — the Account, Danger zone and Sign-in pieces fixed by FIX-2
// (browser verification of the Jobright clone):
//   • "Full name" showed the email address and was read-only. It is the
//     account's name (empty when there is none), editable, saved by the Save bar;
//   • "Years of experience" claimed "New graduate" for the stored default 0;
//   • LinkedIn accepted "not a url";
//   • headings were glued wrongly ("The one-waybuttons.", "looking for .",
//     stray spaces inside Chinese and Japanese headings);
//   • deleting the account required an unmarked "Reason" that was never sent,
//     and promised a confirmation email on a brand that sends none;
//   • the security note printed the raw provider id ("You sign in with phone").
// No network: the preferences run on the stub API, the account hooks are doubles.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../__tests__/utils/mockAuth';
import { flagsWith, renderWithBrand } from '../../../__tests__/shell/helpers';

const account = vi.hoisted(() => ({
  saved: [] as string[],
  failName: false,
  profile: null as null | { hasPassword: boolean; provider: string },
  deleted: [] as string[],
}));
vi.mock('../../../hooks/useAccount', async (orig) => {
  const real = await orig<typeof import('../../../hooks/useAccount')>();
  return {
    ...real,
    useAccountProfile: () => (account.profile ? { data: account.profile, isError: false, refetch: () => undefined } : real.useAccountProfile()),
    useUpdateName: () => ({
      isPending: false,
      mutateAsync: async (name: string) => {
        if (account.failName) throw new Error('request failed');
        account.saved.push(name);
        return { name };
      },
    }),
    useDeleteAccount: () => ({ isPending: false, mutate: (confirm: string) => void account.deleted.push(confirm) }),
  };
});
vi.mock('../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
}));
vi.mock('../../../components/features/onboarding', async (orig) => ({
  ...(await orig<typeof import('../../../components/features/onboarding')>()),
  FinishSetupSettingsLine: () => null,
}));

import SettingsPage from './page';
import { DeleteAccountModal } from '../../../components/v3/account/deleteAccountModal';
import { WipeDataModal } from '../../../components/v3/preferences/WipeDataModal';
import { BrandProvider } from '../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../lib/brand/client';
import { loadMessages } from '../../../lib/i18n';
import { __toastStore } from '../../../components/v3/primitives/Toast';
import { joinTitle, joinTitleTail } from '../../../components/v3/preferences';
import { linkedinInvalid } from '../../../components/v3/preferences/sections/IdentitySection';
import { passwordlessNoteOf } from '../../../components/v3/account/security';
import { raV2Api } from '../../../lib/api/v2';

beforeAll(() => {
  process.env.NEXT_PUBLIC_USE_STUB_API = 'true';
});

beforeEach(() => {
  mockAuthState.value = buildAuthValue();
  account.saved.length = 0;
  account.deleted.length = 0;
  account.failName = false;
  account.profile = null;
  __toastStore.set(() => []);
});

const open = (hash: string, opts: Parameters<typeof renderWithBrand>[1] = {}) => {
  window.history.replaceState(null, '', `/settings#${hash}`);
  return renderWithBrand(<SettingsPage />, opts);
};
const nameField = async () => (await screen.findByLabelText('Full name', {}, { timeout: 4000 })) as HTMLInputElement;

describe('Settings › Account: full name', () => {
  it('an account with no name shows an empty, editable field: never the email address', async () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ email: 'mara@example.com', name: '' }) });
    open('account');
    const name = await nameField();
    expect(name.value).toBe('');
    expect(name).not.toHaveAttribute('readonly');
    expect(name).toHaveAttribute('placeholder', 'Your name');
    // The email shows once, in its own read-only row.
    expect(screen.getAllByDisplayValue('mara@example.com')).toHaveLength(1);
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
  });

  it('a name that was stored as the email address is not shown as a name', async () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ email: 'mara@example.com', name: 'Mara@Example.com' }) });
    open('account');
    expect((await nameField()).value).toBe('');
  });

  it('typing a name raises the Save bar; Save stores it on the account and refreshes the session', async () => {
    const refresh = vi.fn(async () => null);
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ name: '' }), refresh });
    const update = vi.spyOn(raV2Api.preferences, 'update');
    open('account');
    const name = await nameField();
    expect(screen.queryByText('You have unsaved changes')).toBeNull();
    fireEvent.change(name, { target: { value: '  Mara Lindqvist ' } });
    expect(await screen.findByText('You have unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(account.saved).toEqual(['Mara Lindqvist']));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Only the name changed: the preferences are not written.
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it('Discard puts the saved name back; a failed save keeps the typed name and says so', async () => {
    open('account');
    const name = await nameField();
    expect(name.value).toBe('Jane Seeker');
    fireEvent.change(name, { target: { value: 'Someone Else' } });
    fireEvent.click(await screen.findByRole('button', { name: /Discard/i }));
    await waitFor(() => expect(name.value).toBe('Jane Seeker'));
    expect(screen.queryByText('You have unsaved changes')).toBeNull();

    account.failName = true;
    fireEvent.change(name, { target: { value: 'Jane Q. Seeker' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(__toastStore.get().map((x) => x.message)).toContain('Your name was not saved. Try again.'));
    expect(name.value).toBe('Jane Q. Seeker');
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
  });
});

describe('Settings › Account: experience, pronouns, LinkedIn', () => {
  it('the stored default 0 years reads "Not set", not "New graduate"', async () => {
    const real = await raV2Api.preferences.get();
    const get = vi.spyOn(raV2Api.preferences, 'get').mockResolvedValue({ ...real, preferences: { ...real.preferences, yearsExp: 0 } });
    open('account');
    await nameField();
    expect(await screen.findByText('Not set')).toBeInTheDocument();
    expect(screen.queryByText('New graduate')).toBeNull();
    get.mockRestore();
  });

  it('pronoun options come from the bundle (they were hard-coded English in every locale)', async () => {
    open('account');
    await nameField();
    const select = screen.getByLabelText('Pronouns');
    for (const label of ['she/her', 'he/him', 'they/them', 'Other', 'Prefer not to say']) {
      expect(within(select).getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('a LinkedIn value that is not a profile link is flagged and never saved; fixing it clears the message', async () => {
    const update = vi.spyOn(raV2Api.preferences, 'update');
    open('account');
    const linkedin = (await screen.findByLabelText('LinkedIn', {}, { timeout: 4000 })) as HTMLInputElement;
    fireEvent.change(linkedin, { target: { value: 'not a url' } });
    const message = 'Use your LinkedIn profile link (linkedin.com/in/your-name), or leave it empty.';
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(linkedin).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(await screen.findByRole('button', { name: /Save changes/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();

    fireEvent.change(linkedin, { target: { value: 'linkedin.com/in/mara-lindqvist' } });
    await waitFor(() => expect(screen.queryByText(message)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![0]).toMatchObject({ links: { linkedin: 'linkedin.com/in/mara-lindqvist' } });
    update.mockRestore();
  });

  it('linkedinInvalid: profile links with or without the protocol pass; empty passes; anything else fails', () => {
    for (const ok of ['', '  ', 'linkedin.com/in/mara', 'https://www.linkedin.com/in/mara-l/', 'http://linkedin.com/in/mara', 'LinkedIn.com/in/Mara']) {
      expect(linkedinInvalid(ok), ok).toBe(false);
    }
    for (const bad of ['not a url', 'linkedin.com', 'https://example.com/in/mara', 'linkedin.com/company/acme', 'linkedin.com/in/', 'linkedin.com/in/a b']) {
      expect(linkedinInvalid(bad), bad).toBe(true);
    }
  });
});

describe('Settings headings', () => {
  it('English: one space between words, none before the full stop', async () => {
    const danger = open('danger');
    expect(await screen.findByRole('heading', { level: 1, name: 'The one-way buttons.' }, { timeout: 4000 })).toBeInTheDocument();
    danger.unmount();
    const search = open('search');
    expect(await screen.findByRole('heading', { level: 1, name: "Tell us what you're looking for." }, { timeout: 4000 })).toBeInTheDocument();
    search.unmount();
    open('account');
    expect(await screen.findByRole('heading', { level: 1, name: 'Who you are.' }, { timeout: 4000 })).toBeInTheDocument();
  });

  it('joinTitle: no spaces inside Chinese or Japanese; Korean and Latin keep their word spaces', () => {
    expect(joinTitle('The', 'one-way', 'buttons.')).toBe('The one-way buttons.');
    expect(joinTitle('Tell us what', "you're looking for", '.')).toBe("Tell us what you're looking for.");
    expect(joinTitle('關於', '你自己', '。')).toBe('關於你自己。');
    expect(joinTitle('這些是', '無法復原的按鈕。', '')).toBe('這些是無法復原的按鈕。');
    expect(joinTitle('取り消せない', '操作', '。')).toBe('取り消せない操作。');
    expect(joinTitle('당신이', '누구인지', '.')).toBe('당신이 누구인지.');
    expect(joinTitle(' Who ', ' you are', ' ?')).toBe('Who you are?');
    expect(joinTitle('', 'Solo', '')).toBe('Solo');
  });

  // Review finding: Korean endings attach to the noun ("정보예요", "작업이에요"), and
  // script alone cannot tell them from a Korean word. Account and Delete were
  // translated for accent + ending with nothing between; only a Latin word
  // ("buttons.") needs its space.
  it('joinTitleTail: the ending continues the accent, except a Latin word', () => {
    expect(joinTitleTail('The', 'one-way', 'buttons.')).toBe('The one-way buttons.');
    expect(joinTitleTail('Die', 'endgültigen', 'Schaltflächen.')).toBe('Die endgültigen Schaltflächen.');
    expect(joinTitleTail('Who', 'you are', '.')).toBe('Who you are.');
    expect(joinTitleTail('여기에 등록된', '내 정보', '예요.')).toBe('여기에 등록된 내 정보예요.');
    expect(joinTitleTail('되돌릴 수 없는', '작업', '이에요.')).toBe('되돌릴 수 없는 작업이에요.');
    expect(joinTitleTail('這些是', '無法復原', '的按鈕。')).toBe('這些是無法復原的按鈕。');
    expect(joinTitleTail('取り消せない', '操作', '。')).toBe('取り消せない操作。');
    expect(joinTitleTail('Les boutons', 'sans retour', '.')).toBe('Les boutons sans retour.');
    expect(joinTitleTail('', '', 'Solo.')).toBe('Solo.');
    expect(joinTitleTail('Who', 'you are', '')).toBe('Who you are');
  });

  it('every locale: the three section headings as the bundles give them', async () => {
    const want: Record<string, [string, string, string]> = {
      en: ['Who you are.', 'The one-way buttons.', "Tell us what you're looking for."],
      de: ['Wer du bist.', 'Die endgültigen Schaltflächen.', 'Sag uns, was du suchst.'],
      es: ['Quién eres.', 'Los botones sin vuelta atrás.', 'Cuéntanos qué estás buscando.'],
      fr: ['Qui tu es.', 'Les boutons sans retour.', 'Dis-nous ce que tu cherches.'],
      pt: ['Quem você é.', 'Os botões sem volta.', 'Conte o que você procura.'],
      ja: ['ここに登録されているあなたの情報。', '取り消せない操作。', 'どんな仕事を探しているか教えてください。'],
      ko: ['여기에 등록된 내 정보예요.', '되돌릴 수 없는 작업이에요.', '어떤 일을 찾고 있는지 알려주세요.'],
      zh: ['关于你自己。', '这些是不可撤销的按钮。', '告诉我们你在找什么。'],
      'zh-TW': ['關於你自己。', '這些是無法復原的按鈕。', '告訴我們你在找什麼。'],
    };
    for (const [locale, [identity, danger, hunt]] of Object.entries(want)) {
      const bundle = (await import(`../../../i18n/messages/${locale}.json`)).default as { settings: Record<string, Record<string, string>> };
      const part = (section: string) => ['title_before', 'title_em', 'title_after'].map((k) => bundle.settings[section][k]) as [string, string, string];
      expect(joinTitleTail(...part('identity')), `${locale} identity`).toBe(identity);
      expect(joinTitleTail(...part('danger')), `${locale} danger`).toBe(danger);
      expect(joinTitle(...part('hunt')), `${locale} hunt`).toBe(hunt);
    }
  });
});

describe('Danger zone: delete account', () => {
  const openModal = async (opts: Parameters<typeof renderWithBrand>[1] = {}) => {
    open('danger', opts);
    fireEvent.click(await screen.findByRole('button', { name: /Delete account$/ }, { timeout: 4000 }));
    return screen.findByRole('dialog');
  };

  it('asks for no reason (it was required without a mark, and was never sent)', async () => {
    const modal = await openModal();
    expect(within(modal).queryByText('Reason')).toBeNull();
    expect(within(modal).queryByRole('textbox', { name: /reason/i })).toBeNull();
    expect(within(modal).getAllByRole('textbox')).toHaveLength(1);
  });

  it('promises a confirmation email only when this brand sends email', async () => {
    const off = await openModal({ brand: 'goapply', flags: { 'notify.email': false } });
    expect(within(off).queryByText(/email you a confirmation/i)).toBeNull();
    expect(within(off).getByText('You are signed out everywhere right away.')).toBeInTheDocument();
  });

  it('with email on and a real address, it says the confirmation email is coming', async () => {
    const on = await openModal({ brand: 'roboapply', flags: { 'notify.email': true } });
    expect(within(on).getByText(/We will email you a confirmation/)).toBeInTheDocument();
  });
});

// Review finding: a GoApply user (Chinese, no email) had to type "DELETE".
// The word is `accountV2.prefs.danger.confirmKeyword`: a key that is new in
// every bundle, so the staged Chinese merges straight into zh.json (no brand
// override loader is needed, and none exists).
describe('Danger zone: the word to type is in the user\'s language', () => {
  type Tree = { [k: string]: Tree | string };
  const over = (base: Tree, top: Tree): Tree => {
    const out: Tree = { ...base };
    for (const [k, v] of Object.entries(top)) {
      const prev = out[k];
      out[k] = typeof v === 'object' && prev && typeof prev === 'object' ? over(prev, v) : v;
    }
    return out;
  };
  /** A staging file as it is now ({} once the merge has emptied or removed it). */
  const staged = (name: string): Tree => {
    const file = join(process.cwd(), 'i18n/staging', name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Tree) : {};
  };
  /** zh as it is after the staging merge (a key absent from zh.json goes into zh.json). */
  const zhMessages = () => over(loadMessages('zh', 'goapply') as Tree, staged('accountV2.zh.json'));
  const renderZh = (ui: ReactNode) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <NextIntlClientProvider locale="zh" messages={zhMessages()} onError={() => undefined}>
          <BrandProvider brand={clientBrandFor('goapply')} initialCapabilities={{ id: 'goapply', flags: flagsWith({}) }}>
            {ui}
          </BrandProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  const PHONE_ACCOUNT = 'u_8f2c@users.goapply.invalid';

  it('English keeps DELETE', async () => {
    const modal = await (async () => {
      mockAuthState.value = buildAuthValue({ user: buildFakeUser({ email: PHONE_ACCOUNT }) });
      open('danger', { brand: 'goapply', flags: {} });
      fireEvent.click(await screen.findByRole('button', { name: /Delete account$/ }, { timeout: 4000 }));
      return screen.findByRole('dialog');
    })();
    expect(within(modal).getByText('Type DELETE to confirm.')).toBeInTheDocument();
    expect(within(modal).getByPlaceholderText('DELETE')).toBeInTheDocument();
  });

  it('GoApply in Chinese, phone account: asks for 删除, refuses DELETE, and sends the stored address', async () => {
    renderZh(<DeleteAccountModal open onClose={() => undefined} email={PHONE_ACCOUNT} />);
    const modal = await screen.findByRole('dialog');
    expect(within(modal).getByText('输入 删除 以确认。')).toBeInTheDocument();
    const box = within(modal).getByPlaceholderText('删除');
    expect(modal.textContent).not.toMatch(/DELETE/);
    // No promise of an email, in Chinese.
    expect(within(modal).getByText('你会立即在所有设备上退出登录。')).toBeInTheDocument();

    const submit = within(modal).getByRole('button', { name: '删除我的账号' });
    fireEvent.change(box, { target: { value: 'DELETE' } });
    fireEvent.click(submit);
    expect(await within(modal).findByRole('alert')).toHaveTextContent('删除');
    expect(account.deleted).toEqual([]);

    fireEvent.change(box, { target: { value: ' 删除 ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(account.deleted).toEqual([PHONE_ACCOUNT]), { timeout: 8000 });
  }, 12_000);

  it('"Delete job data" asks for the same word', async () => {
    renderZh(<WipeDataModal open onClose={() => undefined} />);
    const modal = await screen.findByRole('dialog');
    expect(within(modal).getByText('输入 删除 以确认。')).toBeInTheDocument();
    expect(within(modal).getByPlaceholderText('删除')).toBeInTheDocument();
    expect(modal.textContent).not.toMatch(/DELETE/);
  });

  it('the staged Chinese covers every new Account, Sign-in and Delete string (no English sentence on GoApply)', () => {
    const en = staged('accountV2.en.json');
    const leaves = (o: Tree, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [`${p}${k}`] : leaves(v, `${p}${k}.`)));
    const zh = zhMessages();
    const at = (o: Tree, path: string) => path.split('.').reduce<Tree | string | undefined>((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), o);
    for (const path of leaves(en)) {
      const value = at(zh, path);
      expect(typeof value, path).toBe('string');
      // Chinese, not the English fallback.
      expect(value as string, path).toMatch(/[\u4e00-\u9fff]|^TA$/);
    }
  });
});

describe('Sign-in and security: why there is no password', () => {
  const t = (key: string, values?: Record<string, string>) => `${key}${values ? `:${values.provider}` : ''}`;

  it('never prints the stored provider id', () => {
    expect(passwordlessNoteOf('phone', t, t)).toBe('phoneNote');
    expect(passwordlessNoteOf('wechat', t, t)).toBe('wechatNote');
    expect(passwordlessNoteOf('google', t, t)).toBe('security.oauthNote:Google');
    expect(passwordlessNoteOf('linkedin_oidc', t, t)).toBe('security.oauthNote:LinkedIn');
    expect(passwordlessNoteOf('line', t, t)).toBe('security.oauthNote:LINE');
    expect(passwordlessNoteOf('some-new-idp', t, t)).toBe('otherNote');
  });

  it('a phone sign-in account reads a sentence, not "You sign in with phone"', async () => {
    account.profile = { hasPassword: false, provider: 'phone' };
    open('security', { brand: 'goapply', flags: {} });
    expect(await screen.findByText('You sign in with a code sent to your phone, so there is no password to change.', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/sign in with phone/)).toBeNull();
  });
});
