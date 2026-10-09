// WP-13 web tests: legal footer, AI badge, legal document page body, privacy
// and consent settings, the "Why this job" lines, and catalog parity.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getLegalFooter: vi.fn(),
  getPublicDisclosures: vi.fn(),
  getPublicRetention: vi.fn(),
  listPiRequests: vi.fn(),
  requestDataExport: vi.fn(),
  createPiRequest: vi.fn(),
  getConsents: vi.fn(),
  recordConsent: vi.fn(),
}));
vi.mock('../../../lib/api/compliance', () => ({
  ...api,
  exportDownloadUrl: (id: string) => `/api/v1/roboapply/compliance/exports/${id}/download`,
}));

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import * as serverContract from '../../../server/src/features/compliance/contract';
import { explainMatch } from '../../../server/src/features/compliance/explainMatch';
import { RETENTION_RULES } from '../../../server/src/features/compliance/retention';
import type { ConsentCatalogItem, LegalFooterModel, PiRequestView } from '../../../lib/api/contracts/compliance';
import { AiGeneratedBadge, LegalFooter } from '../market';
import {
  ConsentsPanel,
  LegalDocument,
  LegalFooterView,
  PrivacyPanel,
  WhyThisJob,
  ComplianceSettingsSection,
} from './index';
import * as webCatalog from './legalCatalog';

const RETENTION = RETENTION_RULES.map(({ id, keep, enforcedBy }) => ({ id, keep, enforcedBy }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getPublicRetention.mockResolvedValue({ items: RETENTION });
  api.getPublicDisclosures.mockResolvedValue({
    brand: 'roboapply',
    models: [{ task: 'default', vendor: 'openrouter', model: 'google/gemini', region: 'US', filingNo: null }],
    filings: {},
    processors: [{ name: 'Neon', purpose: 'database', country: 'US', region: 'us-east-2' }],
    offshore: false,
    statusNote: null,
  });
});
afterEach(() => vi.useRealTimers());

const EMPTY_CN: LegalFooterModel = {
  brand: 'goapply',
  market: 'cn',
  entity: null,
  links: webCatalog.LEGAL_FOOTER_DOCS.cn.map((doc) => ({ doc, href: `/legal/${doc}` })),
  icp: null,
  psb: null,
  edi: null,
  hrLicence: null,
  aiModels: [],
  genaiRegistration: null,
  algorithmFiling: null,
  statusNote: null,
  complaints: null,
};

describe('catalog parity (web mirror = server contract)', () => {
  it('files, aliases and footer docs are identical', () => {
    expect(webCatalog.LEGAL_DOCS).toEqual(serverContract.LEGAL_DOCS);
    expect(webCatalog.LEGAL_DOC_FILES).toEqual(serverContract.LEGAL_DOC_FILES);
    expect(webCatalog.LEGAL_DOC_ALIASES).toEqual(serverContract.LEGAL_DOC_ALIASES);
    expect(webCatalog.LEGAL_DOC_MARKET_ALIASES).toEqual(serverContract.LEGAL_DOC_MARKET_ALIASES);
    expect(webCatalog.LEGAL_FOOTER_DOCS).toEqual(serverContract.LEGAL_FOOTER_DOCS);
    for (const slug of ['terms', 'agreement', 'ai-disclosure', 'cookies', 'x']) {
      for (const market of ['intl', 'cn'] as const) {
        expect(webCatalog.resolveLegalDocSlug(market, slug)).toEqual(serverContract.resolveLegalDocSlug(market, slug));
      }
    }
  });

  it('splits block placeholders out of a document', () => {
    expect(webCatalog.splitLegalBlocks('## A\n\n{{ai_models}}\n\ntext {{brand}}\n{{retention_schedule}}')).toEqual([
      { kind: 'markdown', text: '## A\n\n' },
      { kind: 'block', block: 'ai_models' },
      { kind: 'markdown', text: '\n\ntext {{brand}}\n' },
      { kind: 'block', block: 'retention_schedule' },
    ]);
  });
});

describe('LegalFooter (snapshot with and without env)', () => {
  it('without configured values: document links only', () => {
    const { container } = renderWithBrand(<LegalFooterView model={EMPTY_CN} year={2026} />, { brand: 'goapply' });
    expect(container.querySelectorAll('[data-line]')).toHaveLength(0);
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(EMPTY_CN.links.map((l) => l.href));
    expect(container.textContent).not.toMatch(/备案中|pending/i);
  });

  it('with configured values: every line, regulator links', () => {
    const model: LegalFooterModel = {
      ...EMPTY_CN,
      entity: 'Example Co.',
      icp: { number: 'ICP-1', url: 'https://beian.miit.gov.cn/' },
      psb: { number: 'PSB-1', url: 'https://beian.mps.gov.cn/#/query/webSearch?code=123' },
      edi: 'EDI-1',
      hrLicence: { number: 'HR-1', holder: 'Holder Co.' },
      aiModels: [{ vendor: 'deepseek', model: 'deepseek-chat', filingNo: 'F-1' }, { vendor: 'qwen', model: 'qwen-max', filingNo: null }],
      genaiRegistration: 'REG-1',
      algorithmFiling: 'ALG-1',
      statusNote: 'Note from ops',
      complaints: { email: 'report@example.test', phone: '400-000-0000' },
    };
    const { container } = renderWithBrand(<LegalFooterView model={model} year={2026} />, { brand: 'goapply' });
    const lines = [...container.querySelectorAll('[data-line]')].map((li) => `${li.getAttribute('data-line')}: ${li.textContent}`);
    expect(lines).toMatchInlineSnapshot(`
      [
        "entity: © 2026 Example Co.",
        "icp: ICP filing ICP-1",
        "psb: Public security filing PSB-1",
        "edi: Value-added telecom licence EDI-1",
        "hr: HR service licence HR-1 (Holder Co.)",
        "models: AI models: deepseek-chat (filing F-1), qwen-max",
        "genai: Generative AI service registration REG-1",
        "algo: Algorithm filing ALG-1",
        "note: Filing status: Note from ops",
        "complaintsEmail: Complaints: report@example.test",
        "complaintsPhone: Complaints phone: 400-000-0000",
      ]
    `);
    expect(screen.getByRole('link', { name: 'ICP filing ICP-1' })).toHaveAttribute('href', 'https://beian.miit.gov.cn/');
    expect(screen.getByRole('link', { name: 'Public security filing PSB-1' })).toHaveAttribute('href', 'https://beian.mps.gov.cn/#/query/webSearch?code=123');
  });

  it('the slot fetches the model and shows links while it loads', async () => {
    let resolve: (m: LegalFooterModel) => void = () => {};
    api.getLegalFooter.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWithBrand(<LegalFooter />, { brand: 'goapply' });
    expect(screen.getByRole('link', { name: 'Personal information we collect' })).toHaveAttribute('href', '/legal/pi-collection-list');
    await act(async () => resolve({ ...EMPTY_CN, icp: { number: 'ICP-9', url: 'https://beian.miit.gov.cn/' } }));
    expect(await screen.findByText('ICP filing ICP-9')).toBeInTheDocument();
  });
});

describe('AiGeneratedBadge', () => {
  it('shows on GoApply, renders nothing on RoboApply', () => {
    const go = renderWithBrand(<AiGeneratedBadge kind="document" />, { brand: 'goapply' });
    expect(go.container.querySelector('[data-ai-label="document"]')).toHaveTextContent('AI-assisted document');
    go.unmount();
    const ra = renderWithBrand(<AiGeneratedBadge />, { brand: 'roboapply' });
    expect(ra.container).toBeEmptyDOMElement();
  });
});

describe('LegalDocument', () => {
  it('draft banner, markdown and live tables', async () => {
    renderWithBrand(
      <LegalDocument
        doc="privacy"
        title="Privacy notice"
        body={'## Who we are\n\nText.\n\n{{ai_models}}\n\n{{processors}}\n\n{{retention_schedule}}\n'}
        draft
        version={null}
        updated="2026-10-10"
        market="intl"
        lang="en"
        uiLocale="en"
        otherDocs={['terms', 'privacy']}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeInTheDocument();
    expect(screen.getByTestId('legal-draft-banner')).toHaveTextContent('not final');
    expect(screen.getByRole('heading', { name: 'Who we are' })).toBeInTheDocument();
    expect(await screen.findByText('google/gemini')).toBeInTheDocument();
    expect(screen.getByText('us-east-2', { exact: false })).toBeInTheDocument();
    expect(await screen.findByText('Assistant conversations')).toBeInTheDocument();
    // Inactive accounts and practice recordings: published, not claimed as automatic.
    expect(screen.getAllByText('Not automated yet')).toHaveLength(2);
    expect(document.querySelector('[data-rule="interview_recordings"]')).toHaveTextContent('Not automated yet');
    expect(document.querySelector('[data-rule="soft_deleted_rows"]')).toHaveTextContent('30 daysDeleted automatically');
    // The backup window is not assumed.
    expect(document.querySelector('[data-rule="backups"]')).toHaveTextContent('Not listedSet by our database provider');
    expect(screen.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('aria-current', 'page');
  });

  it('a published document has no draft banner', () => {
    renderWithBrand(
      <LegalDocument doc="terms" title="Terms" body="Body" draft={false} version="v1" updated={null} market="intl" lang="en" uiLocale="en" otherDocs={[]} />,
    );
    expect(screen.queryByTestId('legal-draft-banner')).toBeNull();
    expect(screen.getByText('Version v1')).toBeInTheDocument();
  });
});

// ── Settings ───────────────────────────────────────────────────────────────

const req = (over: Partial<PiRequestView>): PiRequestView => ({
  id: 'r1',
  kind: 'access',
  status: 'open',
  dueAt: '2026-11-02T09:00:00.000Z',
  createdAt: '2026-10-12T09:00:00.000Z',
  resolvedAt: null,
  download: null,
  ...over,
});

describe('PrivacyPanel (#privacy)', () => {
  it('lists requests with due dates and files a new one', async () => {
    api.listPiRequests.mockResolvedValue({ items: [req({})] });
    api.createPiRequest.mockResolvedValue(req({ id: 'r2', kind: 'correction' }));
    renderWithBrand(<ComplianceSettingsSection section="privacy" />);
    expect(await screen.findByText('See what data you hold about me')).toBeInTheDocument();
    expect(screen.getByText(/Answer due by/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New request' }));
    fireEvent.change(screen.getByLabelText('What do you want to do?'), { target: { value: 'correction' } });
    fireEvent.change(screen.getByLabelText(/Details/), { target: { value: 'My school is wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.createPiRequest).toHaveBeenCalledWith({ kind: 'correction', detail: 'My school is wrong' }));
    expect(screen.getByRole('link', { name: 'Go to Danger zone' })).toHaveAttribute('href', '/settings#danger');
  });

  it('starts an export; a finished one shows the download link', async () => {
    api.listPiRequests.mockResolvedValue({ items: [] });
    api.requestDataExport.mockResolvedValue({ exportId: 'w1', requestId: 'r9', status: 'queued' });
    const view = renderWithBrand(<PrivacyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare my data' }));
    await waitFor(() => expect(api.requestDataExport).toHaveBeenCalled());
    view.unmount();

    api.listPiRequests.mockResolvedValue({
      items: [req({ id: 'r9', kind: 'copy', status: 'done', resolvedAt: '2026-10-12T10:00:00.000Z', download: { expiresAt: '2026-10-19T10:00:00.000Z', bytes: 100 } })],
    });
    renderWithBrand(<PrivacyPanel />);
    expect(await screen.findByRole('link', { name: 'Download file' })).toHaveAttribute('href', '/api/v1/roboapply/compliance/exports/r9/download');
  });

  it('a pending export shows its status instead of the button', async () => {
    api.listPiRequests.mockResolvedValue({ items: [req({ kind: 'copy', status: 'in_progress' })] });
    renderWithBrand(<PrivacyPanel />);
    expect(await screen.findByRole('status')).toHaveTextContent('We are preparing your file');
    expect(screen.queryByRole('button', { name: 'Prepare my data' })).toBeNull();
  });
});

const consent = (over: Partial<ConsentCatalogItem>): ConsentCatalogItem => ({
  type: 'ai_resume_parsing',
  required: false,
  stage: 'signup',
  control: 'toggle',
  withdrawable: true,
  onWithdraw: 'none',
  defaultGranted: false,
  prose: '使用 AI 读取我的简历。',
  proseVersion: 'v1',
  proseHash: 'h',
  proseLocale: 'zh',
  granted: null,
  answeredAt: null,
  ...over,
});

describe('ConsentsPanel (#consents, GoApply)', () => {
  it('shows each consent separately with its state; nothing is on by default', async () => {
    api.getConsents.mockResolvedValue({
      items: [
        consent({ type: 'pipl_basic_processing', required: true, withdrawable: false, granted: true, answeredAt: '2026-10-01T00:00:00.000Z', prose: '我已阅读并同意。' }),
        consent({}),
        consent({ type: 'personalized_recommendation', control: 'two_option', prose: '根据我的资料为职位排序。' }),
      ],
    });
    api.recordConsent.mockResolvedValue({ type: 'ai_resume_parsing', granted: true, proseVersion: 'v1', proseHash: 'h', at: 'x', accountClosing: false });
    renderWithBrand(<ConsentsPanel />, { brand: 'goapply' });
    const ai = await screen.findByText('使用 AI 读取我的简历。');
    const row = ai.closest('li')!;
    expect(row).toHaveAttribute('data-state', 'notChosen');
    expect(document.querySelector('[data-consent="pipl_basic_processing"]')).toHaveTextContent('This ends only when you delete your account.');
    expect(within(document.querySelector('[data-consent="pipl_basic_processing"]') as HTMLElement).queryByRole('button')).toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.recordConsent).toHaveBeenCalledWith({ type: 'ai_resume_parsing', granted: true, proseVersion: 'v1', locale: 'en' }));
  });

  it('withdrawing the cross-border consent asks first, then closes the account', async () => {
    api.getConsents.mockResolvedValue({
      items: [consent({ type: 'pipl_cross_border', required: true, granted: true, onWithdraw: 'close_and_purge_account', prose: '境外处理。' })],
    });
    api.recordConsent.mockResolvedValue({ type: 'pipl_cross_border', granted: false, proseVersion: 'v1', proseHash: 'h', at: 'x', accountClosing: true });
    renderWithBrand(<ConsentsPanel />, { brand: 'goapply' });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(api.recordConsent).not.toHaveBeenCalled();
    expect(screen.getByText('Withdraw and delete your account?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('consents-close-confirm'));
    await waitFor(() => expect(api.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipl_cross_border', granted: false })));
    expect(await screen.findByTestId('consents-closing')).toHaveTextContent('Your account is closed');
  });
});

describe('WhyThisJob', () => {
  it('renders the explanation lines with evidence and the mandatory notice', () => {
    const e = explainMatch({
      market: 'cn',
      personalized: true,
      score: 70,
      kind: 'ai',
      dimensions: [{ key: 'skills', weight: 30, score: 90, status: 'scored', evidence: [{ text: 'SQL and Python', source: 'posting' }] }],
      skills: { aligned: [], missing: ['dbt'] },
    });
    renderWithBrand(<WhyThisJob explanation={e} />, { brand: 'goapply' });
    expect(screen.getByText('Why this job: Good fit')).toBeInTheDocument();
    expect(screen.getByText(/From the posting: “SQL and Python”/)).toBeInTheDocument();
    expect(screen.getByText('Asked for, not on your resume: dbt')).toBeInTheDocument();
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });
});
