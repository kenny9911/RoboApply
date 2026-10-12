// WP-54 — People at {company} UI: the People panel per mode and brand, the
// message composer (AI label, copy / mailto / "I sent it", no send button,
// AI off → no draft call), the connections import with "Delete all imported
// connections", the GoApply 内推码 hub (moderated codes with their share
// date, share for review, report) and the tracker follow-up seam. Renders
// through the real en.json + staged English, so a missing key fails here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { RoboApiError } from '../../../lib/api/client';
import type { ConnectionsForJobResponse, ContactView, OutreachDraftView } from '../../../lib/api/contracts/network';
import type { ListReferralCodesResponse, ReferralCodeView } from '../../../lib/api/contracts/cn/referrals';

const api = vi.hoisted(() => ({
  getConnectionsForJob: vi.fn(),
  getConnectionsImportStatus: vi.fn(),
  importLinkedInConnections: vi.fn(),
  deleteImportedConnections: vi.fn(),
  listContacts: vi.fn(),
  listOutreachDrafts: vi.fn(),
  createOutreachDraft: vi.fn(),
  patchOutreachDraft: vi.fn(),
  markDraftCopied: vi.fn(),
  markDraftSent: vi.fn(),
  listReferralCodes: vi.fn(),
  createReferralCode: vi.fn(),
  reportReferralCode: vi.fn(),
  deleteReferralCode: vi.fn(),
}));
vi.mock('../../../lib/api/network', () => api);

vi.mock('../../../hooks/shared/useCreditGate', () => ({
  useCreditGate: () => ({
    left: 3,
    summary: { window: 'day', remaining: 3, grantRemaining: 0, resetsAt: '2026-10-11T00:00:00Z', cap: 3, used: 0 },
    run: async (fn: (key: string) => Promise<unknown>) => ({ ok: true, value: await fn('idem-key') }),
  }),
}));

import { PeoplePanel } from './PeoplePanel';
import { OutreachComposer } from './OutreachComposer';
import { ConnectionsImport } from './ConnectionsImport';
import { ReferralHub } from './ReferralHub';
import { FollowUpDraftButton } from './FollowUpDraftButton';
import { mailtoHref } from './links';

const NOW = '2026-10-10T12:00:00.000Z';

function contact(over: Partial<ContactView> = {}): ContactView {
  return {
    id: 'ct_1',
    source: 'user_connections_import',
    sourceLabel: 'Your LinkedIn connections',
    sourceName: null,
    fullName: 'Ada Lovelace',
    title: 'Staff Engineer',
    companyName: 'Acme',
    linkedinUrl: null,
    connectedOn: '2021-03-15T00:00:00.000Z',
    optedInAt: null,
    ...over,
  };
}

function draft(over: Partial<OutreachDraftView> = {}): OutreachDraftView {
  return {
    id: 'dr_1',
    channel: 'email',
    contactId: null,
    jobId: 'job_1',
    trackerEntryId: null,
    subject: 'Backend Engineer at Acme',
    body: 'Hi Ada,\nI build payment services in Go.',
    copiedAt: null,
    markedSentAt: null,
    aiWritten: true,
    createdAt: NOW,
    ...over,
  };
}

function people(over: Partial<ConnectionsForJobResponse> = {}): ConnectionsForJobResponse {
  return {
    fromYourCompanies: [contact()],
    fromYourSchools: [],
    recruiters: [],
    searchLinks: [],
    mode: 'on',
    importedCount: 120,
    aiAvailable: true,
    drafts: [],
    ...over,
  };
}

function code(over: Partial<ReferralCodeView> = {}): ReferralCodeView {
  return {
    id: 'rc_1',
    company: '示例科技',
    code: 'NT2027ABC',
    programme: '2027届校园招聘',
    expiresAt: '2026-12-31',
    note: null,
    status: 'approved',
    sharedAt: NOW,
    mine: false,
    reportedByMe: false,
    rejectReason: null,
    ...over,
  };
}

const writeText = vi.fn(async () => undefined);
const apiErr = (status: number, code: string, details?: Record<string, unknown>) =>
  new RoboApiError('x', { status, code, payload: { success: false, code, error: 'x', details } });

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText } });
  api.createOutreachDraft.mockResolvedValue(draft());
  api.markDraftCopied.mockResolvedValue(draft({ copiedAt: NOW }));
  api.markDraftSent.mockResolvedValue(draft({ markedSentAt: NOW }));
  api.patchOutreachDraft.mockImplementation(async (_id: string, b: { body?: string }) => draft({ body: b.body ?? '' }));
  api.listOutreachDrafts.mockResolvedValue({ items: [] });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('PeoplePanel (RoboApply)', () => {
  it('mode on: people you know (source named), no hiring-contact section without an opted-in recruiter, and the composer', async () => {
    api.getConnectionsForJob.mockResolvedValue(people());
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />, { flags: { hiringContacts: 'on' } });
    expect(await screen.findByText('People you know at Acme')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Only you can see these people.')).toBeTruthy();
    expect(screen.getByTestId('contact-source').textContent).toBe('From your imported LinkedIn connections');
    expect(screen.queryByTestId('hiring-contacts')).toBeNull();
    expect(screen.getByTestId('outreach-composer')).toBeTruthy();
  });

  it('every own contact names its own source: imported connection or added by you', async () => {
    api.getConnectionsForJob.mockResolvedValue(
      people({
        fromYourCompanies: [
          contact(),
          contact({ id: 'ct_2', source: 'user_added', sourceLabel: 'Added by you', fullName: 'Grace Hopper', connectedOn: null }),
        ],
      }),
    );
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />, { flags: { hiringContacts: 'on' } });
    const section = await screen.findByTestId('people-you-know');
    const rows = within(section).getAllByRole('listitem');
    expect(rows.map((r) => [r.getAttribute('data-source'), within(r).getByTestId('contact-source').textContent])).toEqual([
      ['user_connections_import', 'From your imported LinkedIn connections'],
      ['user_added', 'Added by you'],
    ]);
  });

  it('shows an opted-in hiring contact with its named source', async () => {
    api.getConnectionsForJob.mockResolvedValue(
      people({ recruiters: [contact({ id: 'rec_1', source: 'bank_recruiter', sourceName: 'RoboHire', fullName: 'Rita Recruiter', connectedOn: null, optedInAt: '2026-09-01T00:00:00.000Z' })] }),
    );
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />, { flags: { hiringContacts: 'on' } });
    const section = await screen.findByTestId('hiring-contacts');
    expect(within(section).getByText('Rita Recruiter')).toBeTruthy();
    expect(within(section).getByTestId('recruiter-source').textContent).toMatch(/RoboHire recruiter who chose to be contactable by candidates/);
  });

  it('offers the import when nothing was imported', async () => {
    api.getConnectionsForJob.mockResolvedValue(people({ fromYourCompanies: [], importedCount: 0 }));
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />, { flags: { hiringContacts: 'on' } });
    const cta = await screen.findByTestId('import-cta');
    expect(cta.getAttribute('href')).toBe('/settings#connections');
  });

  it('mode deeplinks_only: no people sections, the composer still works', async () => {
    api.getConnectionsForJob.mockResolvedValue(people({ mode: 'deeplinks_only', fromYourCompanies: [] }));
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />, { flags: { hiringContacts: 'deeplinks_only' } });
    expect(await screen.findByTestId('outreach-composer')).toBeTruthy();
    expect(screen.queryByTestId('people-you-know')).toBeNull();
  });

  it('mode off renders nothing', async () => {
    api.getConnectionsForJob.mockResolvedValue(people({ mode: 'off' }));
    const { container } = renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />);
    await waitFor(() => expect(api.getConnectionsForJob).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="people-panel"]')).toBeNull());
    expect(screen.queryByTestId('outreach-composer')).toBeNull();
  });

  it('"Write to Ada" pre-selects her in the composer', async () => {
    api.getConnectionsForJob.mockResolvedValue(people());
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />, { flags: { hiringContacts: 'on' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Write to Ada' }));
    const to = screen.getByLabelText('To') as HTMLSelectElement;
    expect(to.value).toBe('ct_1');
  });
});

describe('OutreachComposer', () => {
  it('writes a draft with the AI label; copy / email app / "I sent it"; there is no send button', async () => {
    renderWithBrand(<OutreachComposer jobId="job_1" companyName="Acme" contacts={[contact()]} aiAvailable />);
    fireEvent.change(screen.getByLabelText('Kind of message'), { target: { value: 'email' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'ct_1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write a draft' }));
    });
    expect(api.createOutreachDraft).toHaveBeenCalledWith({ jobId: 'job_1', channel: 'email', contactId: 'ct_1', trackerEntryId: undefined }, { idempotencyKey: 'idem-key' });
    expect(await screen.findByText('Written from the job post and your resume.')).toBeTruthy();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toContain('payment services');

    const mail = screen.getByRole('link', { name: 'Open in your email app' });
    expect(mail.getAttribute('href')).toMatch(/^mailto:\?subject=/);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Backend Engineer at Acme'));
    expect(api.markDraftCopied).toHaveBeenCalledWith('dr_1');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I sent it' }));
    });
    expect(api.markDraftSent).toHaveBeenCalledWith('dr_1');
    expect(await screen.findByText(/You marked this as sent on/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^send/i })).toBeNull();
    expect(screen.getByText('RoboApply never sends messages. You send it yourself.')).toBeTruthy();
  });

  it('a LinkedIn note shows the 300-character counter and an Open LinkedIn link; editing over the limit blocks copy', async () => {
    api.createOutreachDraft.mockResolvedValue(draft({ channel: 'linkedin_note', subject: null, body: 'Hi Ada, short note.' }));
    renderWithBrand(<OutreachComposer jobId="job_1" companyName="Acme" aiAvailable />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write a draft' }));
    });
    expect(await screen.findByText('19 of 300 characters')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open LinkedIn' }).getAttribute('href')).toContain('linkedin.com/search/results/people');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'x'.repeat(301) } });
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('AI off: explains it and never calls the draft endpoint', () => {
    renderWithBrand(<OutreachComposer jobId="job_1" companyName="Acme" aiAvailable={false} />);
    expect(screen.getByTestId('outreach-ai-off')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Write a draft' })).toBeNull();
    expect(api.createOutreachDraft).not.toHaveBeenCalled();
  });

  it('shows a plain error when drafting is unavailable', async () => {
    api.createOutreachDraft.mockRejectedValue(apiErr(503, 'ai_unavailable'));
    renderWithBrand(<OutreachComposer jobId="job_1" companyName="Acme" aiAvailable />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write a draft' }));
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Drafting is not available right now. Try again later.');
  });

  it('GoApply offers the WeChat referral request, not a LinkedIn note', () => {
    renderWithBrand(<OutreachComposer jobId="job_1" companyName="示例科技" aiAvailable />, { brand: 'goapply' });
    const options = Array.from((screen.getByLabelText('Kind of message') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['wechat', 'referral_ask', 'email', 'follow_up']);
  });
});

describe('mailtoHref', () => {
  it('carries no address and encodes line breaks', () => {
    expect(mailtoHref('Hi there', 'a\nb')).toBe('mailto:?subject=Hi%20there&body=a%0D%0Ab');
  });
});

describe('ConnectionsImport', () => {
  beforeEach(() => {
    api.getConnectionsImportStatus.mockResolvedValue({ importedCount: 2, lastImportAt: NOW, importsToday: 1, limitPerDay: 3 });
    api.listContacts.mockResolvedValue({ items: [], cursor: null });
  });

  it('lists the people you imported with the company name as the file wrote it (SR-54-2)', async () => {
    api.listContacts.mockResolvedValue({
      items: [
        contact({ companyName: 'Acme Analytics, Inc.' }),
        contact({ id: 'ct_2', fullName: 'Grace Hopper', title: null, companyName: 'Navy Labs', connectedOn: null }),
        contact({ id: 'ct_3', source: 'user_added', sourceLabel: 'Added by you', fullName: 'Lin Example', title: 'Recruiter', companyName: 'Globex Corporation', connectedOn: null }),
      ],
      cursor: null,
    });
    renderWithBrand(<ConnectionsImport />);
    const list = await screen.findByTestId('connections-list');
    expect(within(list).getByText('People you imported')).toBeTruthy();
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => [within(r).getByText(/Lovelace|Hopper|Example/).textContent, within(r).getByTestId('contact-company').textContent])).toEqual([
      ['Ada Lovelace', 'Staff Engineer at Acme Analytics, Inc.'],
      ['Grace Hopper', 'Navy Labs'],
      ['Lin Example', 'Recruiter at Globex Corporation'],
    ]);
    // The written name, never the normalized key the matcher uses.
    expect(list.textContent).not.toContain('acme analytics');
    expect(within(rows[0]!).getByTestId('contact-source').textContent).toBe('From your imported LinkedIn connections · Connected Mar 2021');
    expect(within(rows[2]!).getByTestId('contact-source').textContent).toBe('Added by you');
    expect(api.listContacts).toHaveBeenCalledWith(undefined, expect.anything());
    // Nothing on a row contacts the person.
    expect(within(list).queryByRole('button')).toBeNull();
  });

  it('"Show more" loads the next page with the cursor', async () => {
    api.listContacts.mockImplementation(async (query?: { cursor?: string }) =>
      query?.cursor === 'ct_1'
        ? { items: [contact({ id: 'ct_9', fullName: 'Alan Turing', companyName: 'Bletchley Park' })], cursor: null }
        : { items: [contact({ companyName: 'Acme Analytics, Inc.' })], cursor: 'ct_1' },
    );
    renderWithBrand(<ConnectionsImport />);
    const list = await screen.findByTestId('connections-list');
    fireEvent.click(within(list).getByRole('button', { name: 'Show more' }));
    expect(await within(list).findByText('Alan Turing')).toBeTruthy();
    expect(within(list).getByText('Staff Engineer at Bletchley Park')).toBeTruthy();
    expect(api.listContacts).toHaveBeenLastCalledWith({ cursor: 'ct_1' }, expect.anything());
    expect(within(list).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows no list with nothing imported, when the list fails, or without mode on (the contacts API is gated)', async () => {
    api.getConnectionsImportStatus.mockResolvedValue({ importedCount: 0, lastImportAt: null, importsToday: 0, limitPerDay: 3 });
    const none = renderWithBrand(<ConnectionsImport />);
    expect(await screen.findByText('No connections imported')).toBeTruthy();
    expect(screen.queryByTestId('connections-list')).toBeNull();
    expect(api.listContacts).not.toHaveBeenCalled();
    none.unmount();

    api.getConnectionsImportStatus.mockResolvedValue({ importedCount: 2, lastImportAt: NOW, importsToday: 1, limitPerDay: 3 });
    const off = renderWithBrand(<ConnectionsImport canImport={false} />);
    expect(await screen.findByText('2 connections imported')).toBeTruthy();
    expect(screen.queryByTestId('connections-list')).toBeNull();
    expect(api.listContacts).not.toHaveBeenCalled();
    off.unmount();

    api.listContacts.mockRejectedValue(apiErr(500, 'server_error'));
    renderWithBrand(<ConnectionsImport />);
    expect((await screen.findByTestId('connections-list-error')).textContent).toBe('Your list of people could not be loaded. Try again later.');
  });

  it('explains what is kept, uploads the file and shows the result', async () => {
    api.importLinkedInConnections.mockResolvedValue({ rowCount: 10, importedCount: 8 });
    renderWithBrand(<ConnectionsImport />);
    expect(await screen.findByText('2 connections imported')).toBeTruthy();
    expect(screen.getByText(/Email addresses and profile links in the file are thrown away/)).toBeTruthy();
    const input = screen.getByLabelText('Choose Connections.csv') as HTMLInputElement;
    const file = new File(['First Name,Last Name,Company\n'], 'Connections.csv', { type: 'text/csv' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(api.importLinkedInConnections).toHaveBeenCalledWith(expect.any(FormData));
    expect(await screen.findByText('8 new people from 10 rows.')).toBeTruthy();
  });

  it('shows the daily limit in plain words', async () => {
    api.importLinkedInConnections.mockRejectedValue(apiErr(429, 'rate_limited', { reason: 'connections_import_limit' }));
    renderWithBrand(<ConnectionsImport />);
    const input = await screen.findByLabelText('Choose Connections.csv');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'Connections.csv')] } });
    });
    expect((await screen.findByRole('alert')).textContent).toBe('You have imported 3 times today. Try again tomorrow.');
  });

  it('Delete all imported connections asks first, then deletes', async () => {
    api.deleteImportedConnections.mockResolvedValue({ deleted: 2 });
    renderWithBrand(<ConnectionsImport />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all imported connections' }));
    expect(await screen.findByText('Delete all imported connections?')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    });
    expect(api.deleteImportedConnections).toHaveBeenCalledTimes(1);
  });

  it('without mode on the upload is replaced by a note; delete stays', async () => {
    renderWithBrand(<ConnectionsImport canImport={false} />);
    expect(await screen.findByText('Importing connections is not available yet.')).toBeTruthy();
    expect(screen.queryByLabelText('Choose Connections.csv')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete all imported connections' })).toBeTruthy();
  });
});

describe('ReferralHub (GoApply)', () => {
  const list = (items: ReferralCodeView[], mine: ReferralCodeView[] = []): ListReferralCodesResponse => ({ items, cursor: null, mine });

  it('flag off: not available, nothing is fetched', () => {
    renderWithBrand(<ReferralHub />, { brand: 'goapply' });
    expect(screen.getByText('Referral codes are not available here.')).toBeTruthy();
    expect(api.listReferralCodes).not.toHaveBeenCalled();
  });

  it('lists moderated codes with "Shared by a … user, {month year}"', async () => {
    api.listReferralCodes.mockResolvedValue(list([code()]));
    renderWithBrand(<ReferralHub />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    expect(await screen.findByText('NT2027ABC')).toBeTruthy();
    expect(screen.getByTestId('referral-shared').textContent).toMatch(/^Shared by a \S+ user, October 2026$/);
    expect(screen.getByText('A referral code helps your application reach the company. It does not decide the outcome.')).toBeTruthy();
  });

  it('share for review → pending notice; own codes show their status', async () => {
    api.listReferralCodes.mockResolvedValue(list([], [code({ id: 'rc_9', mine: true, status: 'pending' })]));
    api.createReferralCode.mockResolvedValue(code({ id: 'rc_2', status: 'pending', mine: true }));
    renderWithBrand(<ReferralHub />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    expect(await screen.findByText('Waiting for review')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Company', { selector: 'form:not([role=search]) input' }), { target: { value: '示例科技' } });
    fireEvent.change(screen.getByLabelText('Referral code'), { target: { value: 'NEW2027' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share for review' }));
    });
    expect(api.createReferralCode).toHaveBeenCalledWith({ company: '示例科技', code: 'NEW2027', programme: undefined, expiresAt: undefined, note: undefined });
    expect(await screen.findByText('Thanks. Your code appears after a moderator checks it.')).toBeTruthy();
  });

  it('a refused share explains why', async () => {
    api.listReferralCodes.mockResolvedValue(list([]));
    api.createReferralCode.mockRejectedValue(apiErr(422, 'invalid_request', { reason: 'referral_contact_details' }));
    renderWithBrand(<ReferralHub />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    await screen.findByText('No codes shared for this yet.');
    fireEvent.change(screen.getByLabelText('Company', { selector: 'form:not([role=search]) input' }), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Referral code'), { target: { value: 'AB' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share for review' }));
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Leave out phone numbers, WeChat IDs, emails and links.');
  });

  it('a WeChat-only account is asked to add a phone number before sharing (403 phone_binding_required)', async () => {
    api.listReferralCodes.mockResolvedValue(list([]));
    api.createReferralCode.mockRejectedValue(apiErr(403, 'phone_binding_required', { bindRoute: '/bind-phone' }));
    renderWithBrand(<ReferralHub />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    await screen.findByText('No codes shared for this yet.');
    fireEvent.change(screen.getByLabelText('Company', { selector: 'form:not([role=search]) input' }), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Referral code'), { target: { value: 'AB' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share for review' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.getAttribute('data-error')).toBe('phone_binding_required');
    expect(alert.textContent).toContain('Add a verified mobile number to share or report codes.');
    expect(within(alert).getByRole('link', { name: 'Add phone number' }).getAttribute('href')).toMatch(/^\/bind-phone\?next=/);
  });

  it('report a code with a reason', async () => {
    api.listReferralCodes.mockResolvedValue(list([code()]));
    api.reportReferralCode.mockResolvedValue({ reported: true });
    renderWithBrand(<ReferralHub />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Report' }));
    fireEvent.click(await screen.findByLabelText('Someone asks for money'));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }));
    });
    expect(api.reportReferralCode).toHaveBeenCalledWith('rc_1', { reason: 'paid', note: undefined });
  });

  it('reporting without a bound phone asks for one in the dialog', async () => {
    api.listReferralCodes.mockResolvedValue(list([code()]));
    api.reportReferralCode.mockRejectedValue(apiErr(403, 'phone_binding_required', { bindRoute: '/bind-phone' }));
    renderWithBrand(<ReferralHub />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }));
    });
    const alert = await within(dialog).findByRole('alert');
    expect(alert.getAttribute('data-error')).toBe('phone_binding_required');
    expect(within(alert).getByRole('link', { name: 'Add phone number' })).toBeTruthy();
  });
});

describe('PeoplePanel (GoApply)', () => {
  it('shows referral codes for the company and the WeChat request draft', async () => {
    api.getConnectionsForJob.mockResolvedValue(people({ mode: 'deeplinks_only', fromYourCompanies: [] }));
    api.listReferralCodes.mockResolvedValue({ items: [code()], cursor: null, mine: [] });
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="示例科技" />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    expect(await screen.findByTestId('referrals-for-company')).toBeTruthy();
    expect(await screen.findByText('NT2027ABC')).toBeTruthy();
    expect(api.listReferralCodes).toHaveBeenCalledWith(expect.objectContaining({ company: '示例科技' }), expect.anything());
    expect(screen.queryByTestId('people-you-know')).toBeNull();
  });

  // D5: hiring contacts and people you know are not a RoboApply-only feature.
  it('mode on: an opted-in GoHire recruiter and the people you know show above the 内推码 block', async () => {
    api.getConnectionsForJob.mockResolvedValue(
      people({
        recruiters: [contact({ id: 'rec_cn', source: 'bank_recruiter', sourceName: 'GoHire', fullName: '王招聘', companyName: '示例科技', connectedOn: null, optedInAt: '2026-09-01T00:00:00.000Z' })],
        fromYourCompanies: [contact({ id: 'ct_cn', fullName: '李同学', companyName: '示例科技' })],
      }),
    );
    api.listReferralCodes.mockResolvedValue({ items: [code()], cursor: null, mine: [] });
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="示例科技" />, { brand: 'goapply', flags: { hiringContacts: 'on', 'cn.referralCodes': true } });
    const recruiters = await screen.findByTestId('hiring-contacts');
    expect(within(recruiters).getByText('王招聘')).toBeTruthy();
    expect(within(recruiters).getByTestId('recruiter-source').textContent).toMatch(/GoHire recruiter who chose to be contactable by candidates/);
    const known = screen.getByTestId('people-you-know');
    expect(within(known).getByText('李同学')).toBeTruthy();
    const codes = await screen.findByTestId('referrals-for-company');
    // Order on the page: hiring contact, people you know, then the referral codes.
    const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(recruiters, known)).toBe(true);
    expect(before(known, codes)).toBe(true);
    expect(screen.getByTestId('outreach-composer')).toBeTruthy();
  });

  it('mode on with nobody to show: no empty people section and no LinkedIn import prompt, only what exists', async () => {
    api.getConnectionsForJob.mockResolvedValue(people({ fromYourCompanies: [], importedCount: 0 }));
    api.listReferralCodes.mockResolvedValue({ items: [code()], cursor: null, mine: [] });
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="示例科技" />, { brand: 'goapply', flags: { hiringContacts: 'on', 'cn.referralCodes': true } });
    expect(await screen.findByTestId('referrals-for-company')).toBeTruthy();
    expect(screen.queryByTestId('people-you-know')).toBeNull();
    expect(screen.queryByTestId('hiring-contacts')).toBeNull();
    expect(screen.queryByTestId('import-cta')).toBeNull();
  });

  it('mode off and no referral codes renders nothing, as on RoboApply; with the codes on it shows the codes', async () => {
    api.getConnectionsForJob.mockResolvedValue(people({ mode: 'off', fromYourCompanies: [] }));
    const none = renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="示例科技" />, { brand: 'goapply', flags: {} });
    await waitFor(() => expect(api.getConnectionsForJob).toHaveBeenCalled());
    await waitFor(() => expect(none.container.querySelector('[data-testid="people-panel"]')).toBeNull());
    expect(screen.queryByTestId('outreach-composer')).toBeNull();
    none.unmount();
    api.listReferralCodes.mockResolvedValue({ items: [code()], cursor: null, mine: [] });
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="示例科技" />, { brand: 'goapply', flags: { 'cn.referralCodes': true } });
    expect(await screen.findByTestId('referrals-for-company')).toBeTruthy();
  });

  // `connectedOn` is a date-only value stored at UTC midnight: it is formatted in UTC, so the
  // first of a month never reads as the month before west of UTC (run with TZ=America/Los_Angeles to see it).
  it('a connected-on date on the first of a month shows that month', async () => {
    api.getConnectionsForJob.mockResolvedValue(people({ fromYourCompanies: [contact({ connectedOn: '2021-03-01T00:00:00.000Z' })] }));
    renderWithBrand(<PeoplePanel jobId="job_1" companyId={null} companyName="Acme" />, { flags: { hiringContacts: 'on' } });
    expect(await screen.findByText(/Connected Mar 2021/)).toBeTruthy();
  });
});

describe('FollowUpDraftButton', () => {
  it('renders nothing without a job', () => {
    const { container } = renderWithBrand(<FollowUpDraftButton jobId={null} trackerEntryId="te_1" companyName="Acme" />);
    expect(container.querySelector('[data-testid="follow-up-draft"]')).toBeNull();
  });

  it('opens the composer set to a follow-up saved on the application', async () => {
    api.getConnectionsForJob.mockResolvedValue(people());
    api.createOutreachDraft.mockResolvedValue(draft({ channel: 'follow_up', trackerEntryId: 'te_1' }));
    renderWithBrand(<FollowUpDraftButton jobId="job_1" trackerEntryId="te_1" companyName="Acme" />);
    fireEvent.click(screen.getByRole('button', { name: 'Write a follow-up' }));
    const kind = (await screen.findByLabelText('Kind of message')) as HTMLSelectElement;
    expect(kind.value).toBe('follow_up');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Write a draft' }));
    });
    expect(api.createOutreachDraft).toHaveBeenCalledWith(expect.objectContaining({ channel: 'follow_up', trackerEntryId: 'te_1' }), expect.anything());
    expect(await screen.findByText('Saved with this application.')).toBeTruthy();
  });
});
