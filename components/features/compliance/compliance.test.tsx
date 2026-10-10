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

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { ANALYTICS_CONSENT_COOKIE, isAnalyticsConsentRequired, onAnalyticsConsentReview } from '../../../lib/analytics';
import * as serverContract from '../../../server/src/features/compliance/contract';
import { buildDisclosures } from '../../../server/src/features/compliance/disclosures';
import { explainMatch } from '../../../server/src/features/compliance/explainMatch';
import { RETENTION_RULES } from '../../../server/src/features/compliance/retention';
import { getBrand } from '../../../server/src/platform/brand/registry';
import { MAINLAND_LLM_HOST_SUFFIXES, hostOf } from '../../../server/src/platform/llm/brandPolicy';
import { OPENROUTER_MAINLAND_UPSTREAMS, PROVIDER_DEFAULT_BASE_URLS } from '../../../server/src/platform/llm/egressPolicy';
import { jobDataAttributions } from '../../../server/src/features/jobs/data';
import type { ConsentCatalogItem, DisclosuresResponse, LegalFooterModel, PiRequestView } from '../../../lib/api/contracts/compliance';
import { AiGeneratedBadge, LegalFooter } from '../market';
import {
  ConsentsPanel,
  DataAttributions,
  LegalDocument,
  LegalFooterView,
  LegalIndex,
  LlmEndpoints,
  PrivacyPanel,
  ProcessingFacts,
  ProcessorsTable,
  RetentionTable,
  WhyThisJob,
  ComplianceSettingsSection,
} from './index';
import * as webCatalog from './legalCatalog';

const RETENTION = RETENTION_RULES.map(({ id, keep, enforcedBy }) => ({ id, keep, enforcedBy }));

/** What the server answers for a brand on a given configuration — the real builder, not a hand-written list. */
function disclosuresFor(brand: 'roboapply' | 'goapply', env: Record<string, string> = {}): DisclosuresResponse {
  return buildDisclosures(getBrand(brand), env);
}

const RA_DISCLOSURES: DisclosuresResponse = {
  ...disclosuresFor('roboapply'),
  models: [{ task: 'default', vendor: 'openrouter', model: 'google/gemini', region: 'US', filingNo: null }],
  processors: [{ name: 'Neon', purpose: 'database', country: 'US', region: 'us-east-2' }],
};

function clearConsentCookie(): void {
  document.cookie = `${ANALYTICS_CONSENT_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getPublicRetention.mockResolvedValue({ items: RETENTION });
  api.getPublicDisclosures.mockResolvedValue(RA_DISCLOSURES);
  clearConsentCookie();
});
afterEach(() => {
  vi.useRealTimers();
  clearConsentCookie();
});

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

  it('splits the WP-93 fact blocks too, and leaves inline placeholders in the text', () => {
    expect(webCatalog.LEGAL_BLOCKS).toEqual(['retention_schedule', 'ai_models', 'processors', 'processing_facts', 'llm_endpoints', 'data_attributions']);
    expect(webCatalog.splitLegalBlocks('{{processing_facts}}\n\nA {{takedown_contact}}\n\n  {{ llm_endpoints }}  \n{{data_attributions}}\n{{unknown_block}}')).toEqual([
      { kind: 'block', block: 'processing_facts' },
      { kind: 'markdown', text: '\n\nA {{takedown_contact}}\n\n' },
      { kind: 'block', block: 'llm_endpoints' },
      { kind: 'block', block: 'data_attributions' },
      { kind: 'markdown', text: '\n{{unknown_block}}' },
    ]);
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
    // The documents and nothing else: GoApply passes do not renew, so there is no subscription to cancel.
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(EMPTY_CN.links.map((l) => l.href));
    expect(screen.queryByTestId('privacy-choices')).toBeNull();
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

const EMPTY_INTL: LegalFooterModel = {
  ...EMPTY_CN,
  brand: 'roboapply',
  market: 'intl',
  links: webCatalog.LEGAL_FOOTER_DOCS.intl.map((doc) => ({ doc, href: `/legal/${doc}` })),
};

describe('LegalFooterView: "Privacy choices" (WP-93)', () => {
  it('is hidden until the visitor has answered the analytics question; then it opens the question again', async () => {
    const asked = vi.fn();
    const stop = onAnalyticsConsentReview(asked);
    const view = renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} />);
    // No answer on this device: there is nothing to review, so no button that would do nothing.
    expect(screen.queryByTestId('privacy-choices')).toBeNull();
    view.unmount();

    document.cookie = `${ANALYTICS_CONSENT_COOKIE}=denied; path=/`;
    renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} />);
    const button = await screen.findByRole('button', { name: 'Privacy choices' });
    expect(button).toHaveAttribute('type', 'button');
    expect(asked).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(asked).toHaveBeenCalledTimes(1);
    stop();
  });

  it('appears on the same page once the visitor answers the banner (the answer is a click)', async () => {
    renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} />);
    expect(screen.queryByTestId('privacy-choices')).toBeNull();
    document.cookie = `${ANALYTICS_CONSENT_COOKIE}=granted; path=/`;
    fireEvent.click(document.body);
    expect(await screen.findByTestId('privacy-choices')).toBeInTheDocument();
  });

  it('GoApply never asks the question, so its footer has no such control; a host can force it either way', async () => {
    // The rule the GoApply privacy draft relies on: no analytics question in any country.
    for (const country of [null, 'CN', 'DE', 'TW']) expect(isAnalyticsConsentRequired('cn', country)).toBe(false);
    renderWithBrand(<LegalFooterView model={EMPTY_CN} year={2026} />, { brand: 'goapply' });
    await act(async () => {});
    expect(screen.queryByTestId('privacy-choices')).toBeNull();
    cleanupAll();

    document.cookie = `${ANALYTICS_CONSENT_COOKIE}=granted; path=/`;
    renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} privacyChoices={false} />);
    await act(async () => {});
    expect(screen.queryByTestId('privacy-choices')).toBeNull();
    cleanupAll();
    clearConsentCookie();
    renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} privacyChoices />);
    expect(screen.getByTestId('privacy-choices')).toBeInTheDocument();
  });
});

describe('LegalFooterView: "Cancel a subscription" (CancelFooterLink)', () => {
  it('is in the footer on pages without the marketing chrome', () => {
    renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} />);
    const footer = screen.getByTestId('legal-footer');
    const link = within(footer).getByTestId('cancel-footer-link');
    expect(link).toHaveAttribute('href', '/cancel');
    expect(link.textContent?.trim().length).toBeGreaterThan(3);
  });

  it('GoApply (passes never renew): the footer does not add the link; a host can still force it', async () => {
    renderWithBrand(<LegalFooterView model={EMPTY_CN} year={2026} />, { brand: 'goapply' });
    await act(async () => {});
    expect(screen.getByTestId('legal-footer')).toHaveAttribute('data-market', 'cn');
    expect(screen.queryByTestId('cancel-footer-link')).toBeNull();
    expect(screen.queryByRole('link', { name: /cancel/i })).toBeNull();
    cleanupAll();
    // RoboApply, same empty model: the link is there.
    renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} />);
    expect(screen.getByTestId('cancel-footer-link')).toBeInTheDocument();
    cleanupAll();
    renderWithBrand(<LegalFooterView model={EMPTY_CN} year={2026} cancelLink />, { brand: 'goapply' });
    expect(screen.getByTestId('cancel-footer-link')).toHaveAttribute('href', '/cancel');
  });

  it('is not printed twice where the marketing chrome already shows it', async () => {
    renderWithBrand(
      <div>
        <nav>
          <a href="/cancel" data-testid="cancel-footer-link">
            from the marketing footer column
          </a>
        </nav>
        <LegalFooterView model={EMPTY_INTL} year={2026} />
      </div>,
    );
    await waitFor(() => expect(screen.getAllByTestId('cancel-footer-link')).toHaveLength(1));
    expect(within(screen.getByTestId('legal-footer')).queryByTestId('cancel-footer-link')).toBeNull();
    expect(screen.getByText('from the marketing footer column')).toBeInTheDocument();
  });

  it('cancelLink forces it on or off', async () => {
    renderWithBrand(<LegalFooterView model={EMPTY_INTL} year={2026} cancelLink={false} />);
    await act(async () => {});
    expect(screen.queryByTestId('cancel-footer-link')).toBeNull();
    cleanupAll();
    renderWithBrand(
      <div>
        <a href="/cancel" data-testid="cancel-footer-link">
          other
        </a>
        <LegalFooterView model={EMPTY_INTL} year={2026} cancelLink />
      </div>,
    );
    await act(async () => {});
    expect(screen.getAllByTestId('cancel-footer-link')).toHaveLength(2);
  });
});

describe('facts rendered from the server response (no hard-coded vendor list)', () => {
  it('RoboApply: where data is processed, and the AI endpoints that may and may not be used', () => {
    const data = disclosuresFor('roboapply');
    renderWithBrand(
      <>
        <ProcessingFacts data={data} />
        <LlmEndpoints data={data} />
      </>,
    );
    const facts = screen.getByTestId('processing-facts');
    expect(facts).toHaveAttribute('data-stage', 'intl');
    expect(within(facts).getByText('This service runs outside mainland China.')).toBeInTheDocument();
    // 'local' = no outside parser is called. It is not a claim that only our servers read the resume.
    expect(data.processing).toMatchObject({ resumeParsing: 'local', resumeParser: null });
    expect(facts.querySelector('[data-fact="parsing"]')).toHaveTextContent(
      'Your resume is not sent to a separate resume-parsing service. When AI reads it, including scanned pages and images, it goes to an AI model provider.',
    );
    expect(facts).not.toHaveTextContent(/own servers/);
    expect(facts.querySelector('[data-fact="redacted"]')).toBeNull();

    const endpoints = screen.getByTestId('llm-endpoints');
    expect(endpoints).toHaveAttribute('data-rule', 'no_mainland');
    expect(endpoints).toHaveTextContent('never sent to an AI service in mainland China');
    // Every usable provider row is the policy table's own host for that provider.
    const rows = [...endpoints.querySelectorAll('tr[data-provider]')];
    expect(rows.length).toBe(data.llmEndpoints.providers.length);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const provider = row.getAttribute('data-provider')!;
      expect(row).toHaveTextContent(hostOf(PROVIDER_DEFAULT_BASE_URLS[provider])!);
    }
    // Every refused mainland host and every excluded upstream of the policy is on the page.
    const refused = [...endpoints.querySelectorAll('[data-list="mainland-hosts"] li')].map((li) => li.textContent);
    expect(refused).toEqual([...MAINLAND_LLM_HOST_SUFFIXES]);
    const excluded = [...endpoints.querySelectorAll('[data-list="excluded-upstreams"] li')].map((li) => li.textContent);
    expect(excluded).toEqual([...OPENROUTER_MAINLAND_UPSTREAMS]);
    // No mainland host is offered as usable.
    for (const row of rows) for (const host of MAINLAND_LLM_HOST_SUFFIXES) expect(row.textContent).not.toContain(host);
  });

  it('GoApply (offshore beta): files not kept, identifiers removed, images discarded; domestic endpoints only', () => {
    const data = disclosuresFor('goapply');
    renderWithBrand(
      <>
        <ProcessingFacts data={data} />
        <LlmEndpoints data={data} />
      </>,
      { brand: 'goapply' },
    );
    const facts = screen.getByTestId('processing-facts');
    expect(facts).toHaveAttribute('data-stage', 'cn0');
    expect(facts.querySelector('[data-fact="region"]')).toHaveTextContent('This service runs outside mainland China.');
    expect(facts.querySelector('[data-fact="files"]')).toHaveTextContent('read in memory only');
    expect(facts.querySelector('[data-fact="redacted"]')?.textContent).toMatch(/^Removed from the resume text before it is stored: .+\.$/);
    expect(facts.querySelector('[data-fact="redacted"]')?.textContent).not.toMatch(/processing\.pii|prc_id|us_ssn/); // every kind has a label
    expect(facts.querySelector('[data-fact="images"]')).toHaveTextContent('not stored');

    const endpoints = screen.getByTestId('llm-endpoints');
    expect(endpoints).toHaveAttribute('data-rule', 'mainland_only');
    expect(endpoints).toHaveTextContent('Only AI services in mainland China are used.');
    expect(endpoints.querySelector('[data-list="excluded-upstreams"]')).toBeNull();
    const providers = [...endpoints.querySelectorAll('tr[data-provider]')].map((r) => r.getAttribute('data-provider'));
    expect(providers).toEqual(data.llmEndpoints.providers.map((p) => p.provider));
    for (const offshore of ['openai', 'openrouter', 'anthropic', 'google']) expect(providers).not.toContain(offshore);
  });

  it('a mainland deployment and kept files read differently — the page follows the configuration', () => {
    const data = disclosuresFor('goapply', {
      DEPLOY_REGION: 'cn-mainland',
      CN_S3_BUCKET: 'cn',
      CN_S3_ENDPOINT: 'https://oss-cn-shanghai.example.test',
      CN_S3_ACCESS_KEY_ID: 'a',
      CN_S3_SECRET_ACCESS_KEY: 's',
    });
    renderWithBrand(<ProcessingFacts data={data} />, { brand: 'goapply' });
    const facts = screen.getByTestId('processing-facts');
    expect(facts.querySelector('[data-fact="region"]')).toHaveTextContent('This service runs in mainland China.');
    // Kept files are stated without the bucket endpoint: the response does not carry it.
    expect(data.processing.originalFiles).toBe('kept');
    expect(facts.querySelector('[data-fact="files"]')?.textContent).toBe('Resume files you upload are kept in our own file storage.');
    expect(JSON.stringify(data)).not.toContain('oss-cn-shanghai');
    expect(facts).not.toHaveTextContent('oss-cn-shanghai');
  });

  it('the outside resume parser is named from the server response, never by the page', () => {
    const data = disclosuresFor('goapply', { GOHIRE_API_KEY: 'k' });
    expect(data.processing).toMatchObject({ resumeParsing: 'gohire_mainland' });
    const parser = data.processing.resumeParser!;
    expect(parser).toBeTruthy();
    const view = renderWithBrand(<ProcessingFacts data={data} />, { brand: 'goapply' });
    expect(screen.getByTestId('processing-facts').querySelector('[data-fact="parsing"]')?.textContent).toBe(
      `Your resume is read by the ${parser} parsing service on servers in mainland China.`,
    );
    view.unmount();
    // Another name in the response is the name on the page.
    const renamed = renderWithBrand(<ProcessingFacts data={{ ...data, processing: { ...data.processing, resumeParser: 'Example Parser' } }} />, { brand: 'goapply' });
    expect(screen.getByTestId('processing-facts').querySelector('[data-fact="parsing"]')).toHaveTextContent('read by the Example Parser parsing service');
    renamed.unmount();
    // No name in the response: the page states only that no outside parser is used.
    renderWithBrand(<ProcessingFacts data={{ ...data, processing: { ...data.processing, resumeParser: null } }} />, { brand: 'goapply' });
    expect(screen.getByTestId('processing-facts').querySelector('[data-fact="parsing"]')).toHaveTextContent('not sent to a separate resume-parsing service');
  });

  it('the Aliyun content-safety processor row has a translated purpose', () => {
    const data = disclosuresFor('goapply', { CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green', ALIYUN_GREEN_ACCESS_KEY_ID: 'ak', ALIYUN_GREEN_ACCESS_KEY_SECRET: 'sk' });
    renderWithBrand(<ProcessorsTable data={data} />, { brand: 'goapply' });
    const row = screen.getByText('Aliyun Content Moderation').closest('tr')!;
    expect(row).toHaveTextContent('Content safety checks');
    expect(row).toHaveTextContent('CN');
  });

  it('data attributions: each dataset that needs credit, with its licence and a link; none → says so', () => {
    const data = disclosuresFor('roboapply');
    const view = renderWithBrand(<DataAttributions data={data} />);
    const required = jobDataAttributions().filter((a) => a.attributionRequired);
    const rows = [...screen.getByTestId('data-attributions').querySelectorAll('tr[data-source]')];
    expect(rows.map((r) => r.getAttribute('data-source'))).toEqual(required.map((a) => a.source.id));
    for (const a of required) {
      const row = rows.find((r) => r.getAttribute('data-source') === a.source.id)!;
      expect(row).toHaveTextContent(a.source.publisher);
      expect(row).toHaveTextContent(a.source.license);
      expect(row).toHaveTextContent(a.asOf);
      if (a.source.url) expect(within(row as HTMLElement).getByRole('link', { name: a.source.name })).toHaveAttribute('href', a.source.url);
    }
    expect(rows[0]).toHaveTextContent('Job role categories');
    // Phone layout (/legal at 375px ran past the screen edge): the five-column table stacks, so every cell names its column.
    const table = screen.getByTestId('data-attributions').querySelector('table')!;
    expect(table.className).toMatch(/tableStack/);
    expect(screen.getByTestId('data-attributions').className).toMatch(/tableWrapStack/);
    expect([...rows[0]!.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(['Dataset', 'Publisher', 'Used for', 'Licence', 'Copy dated']);
    view.unmount();
    renderWithBrand(<DataAttributions data={{ ...data, dataAttributions: [] }} />);
    expect(screen.getByText('No dataset that requires attribution is in use.')).toBeInTheDocument();
  });

  it('no vendor, host or dataset name is written in the components or the bundles; bundles name no brand', () => {
    const root = process.cwd();
    const sources = ['DisclosureTables.tsx', 'LegalIndex.tsx', 'LegalDocument.tsx', 'LegalFooterView.tsx'].map((f) =>
      readFileSync(path.join(root, 'components/features/compliance', f), 'utf8'),
    );
    // The `legal` namespace of the en and zh bundles (WP-91 merged it out of i18n/staging).
    const bundles = ['en.json', 'zh.json'].map((f) => JSON.stringify((JSON.parse(readFileSync(path.join(root, 'i18n/messages', f), 'utf8')) as { legal: unknown }).legal));
    for (const text of bundles) expect(text.length).toBeGreaterThan(2000);
    const hosts = Object.values(PROVIDER_DEFAULT_BASE_URLS)
      .map((u) => hostOf(u))
      .filter((h): h is string => Boolean(h) && h !== 'localhost');
    const names = [...new Set([...hosts, ...MAINLAND_LLM_HOST_SUFFIXES, ...Object.keys(PROVIDER_DEFAULT_BASE_URLS).filter((p) => p.length > 4), 'O*NET', 'GeoNames', 'GoHire'])];
    expect(names.length).toBeGreaterThan(20);
    for (const text of [...sources, ...bundles]) {
      for (const name of names) expect(text.toLowerCase().includes(name.toLowerCase()), name).toBe(false);
    }
    for (const text of bundles) expect(text).not.toMatch(/RoboApply|GoApply/);
  });
});

describe('RetentionTable: the rows added in WP-93', () => {
  it('renders every rule with a label, and the new rows with their period and how they end', () => {
    renderWithBrand(<RetentionTable items={RETENTION} />);
    const cell = (id: string) => document.querySelector(`[data-rule="${id}"]`);
    for (const r of RETENTION) {
      expect(cell(r.id), r.id).not.toBeNull();
      expect(cell(r.id)!.textContent, r.id).not.toContain('retention.rows.');
      expect(cell(r.id)!.textContent, r.id).not.toContain('retention.enforced.');
    }
    expect(cell('known_devices')).toHaveTextContent('Devices you signed in from, after the last sign-in from that device90 daysDeleted automatically');
    expect(cell('tool_results')).toHaveTextContent('Free tool results (the report and the text read from your file)24 hoursDeleted automatically');
    expect(cell('anon_alerts_unconfirmed')).toHaveTextContent('72 hoursDeleted automatically');
    expect(cell('anon_alerts_unsubscribed')).toHaveTextContent('30 daysDeleted automatically');
    // A minimum, not a deletion: 3 years, and the row says what ends it.
    expect(cell('billing_consent_records')).toHaveTextContent('36 monthsKept at least this long; deleted with your account');
    expect(cell('content_safety_events')).toHaveTextContent('180 daysDeleted automatically');
    expect(cell('assistant_messages')).toHaveTextContent('12 monthsDeleted automatically');
    // Still the only row that is not automated (owner decision pending).
    expect(screen.getAllByText('Not automated yet')).toHaveLength(1);
    expect(cell('inactive_accounts')).toHaveTextContent('Not automated yet');
  });

  it('the en and zh bundles label every rule and every way a row ends', () => {
    for (const file of ['en.json', 'zh.json']) {
      const legal = (JSON.parse(readFileSync(path.join(process.cwd(), 'i18n/messages', file), 'utf8')) as { legal: { retention: { rows: Record<string, string>; enforced: Record<string, string> } } }).legal;
      expect(Object.keys(legal.retention.rows).sort(), file).toEqual(RETENTION.map((r) => r.id).sort());
      expect(Object.keys(legal.retention.enforced).sort(), file).toEqual(['auto', 'manual', 'minimum', 'provider']);
    }
  });
});

describe('LegalIndex (/legal)', () => {
  it('lists the documents and renders every fact block from the server', async () => {
    renderWithBrand(
      <LegalIndex
        market="intl"
        docs={[
          { doc: 'terms', draft: true, updated: '2026-10-10' },
          { doc: 'privacy', draft: false, updated: '2026-10-10' },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Legal' })).toBeInTheDocument();
    const terms = screen.getByRole('link', { name: /Terms of service/ });
    expect(terms).toHaveAttribute('href', '/legal/terms');
    expect(terms).toHaveTextContent('Draft');
    expect(screen.getByRole('link', { name: /Privacy notice/ })).toHaveTextContent('Last updated 2026-10-10');
    for (const heading of ['Documents', 'Where your data is processed', 'Where AI requests can go', 'How long we keep data', 'Data we credit']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    expect(await screen.findByTestId('processing-facts')).toBeInTheDocument();
    expect(await screen.findByTestId('llm-endpoints')).toBeInTheDocument();
    expect(await screen.findByTestId('data-attributions')).toBeInTheDocument();
    expect(await screen.findByText('Assistant conversations')).toBeInTheDocument();
    expect(screen.getByText('Neon')).toBeInTheDocument();
  });
});

function cleanupAll(): void {
  document.body.innerHTML = '';
}

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
        body={'## Who we are\n\nText.\n\n{{ai_models}}\n\n{{processors}}\n\n{{retention_schedule}}\n\n{{processing_facts}}\n\n{{llm_endpoints}}\n\n{{data_attributions}}\n'}
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
    // Inactive accounts: published, not claimed as automatic. Practice recordings
    // are purged by WP-63a's interview retention since the Wave 4 gate.
    expect(screen.getAllByText('Not automated yet')).toHaveLength(1);
    expect(document.querySelector('[data-rule="inactive_accounts"]')).toHaveTextContent('Not automated yet');
    expect(document.querySelector('[data-rule="interview_recordings"]')).toHaveTextContent('90 daysDeleted automatically');
    expect(document.querySelector('[data-rule="soft_deleted_rows"]')).toHaveTextContent('30 daysDeleted automatically');
    // The backup window is not assumed.
    expect(document.querySelector('[data-rule="backups"]')).toHaveTextContent('Not listedSet by our database provider');
    expect(screen.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('aria-current', 'page');
    // The fact blocks render as live components, not as text.
    expect(await screen.findByTestId('processing-facts')).toBeInTheDocument();
    expect(await screen.findByTestId('llm-endpoints')).toBeInTheDocument();
    expect(await screen.findByTestId('data-attributions')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\{\{/);
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

  // Review finding: a consent given under the old text was shown as agreed next to the new text.
  it('a consent given to an earlier text says so and can be agreed to again; the rest are unchanged', async () => {
    api.getConsents.mockResolvedValue({
      items: [
        consent({ type: 'pipl_cross_border', required: true, granted: true, answeredAt: '2026-10-10T00:00:00.000Z', answeredProseVersion: 'v0', answeredTextCurrent: false, proseVersion: 'v1', prose: '境外处理方：数据库 Neon。' }),
        consent({ type: 'pipl_basic_processing', required: true, withdrawable: false, granted: true, answeredAt: '2026-10-10T00:00:00.000Z', answeredProseVersion: 'v0', answeredTextCurrent: true, prose: '我已阅读并同意。' }),
        consent({ type: 'marketing_email', granted: true, answeredAt: '2026-10-10T00:00:00.000Z', prose: '营销消息。' }),
        // A sign-up record with no hash: the catalog cannot compare it with any text (null = unknown, not "changed").
        consent({ type: 'age_16_plus', required: true, withdrawable: false, granted: true, answeredAt: '2026-10-10T00:00:00.000Z', answeredProseVersion: 'authCn.2026-10-10.v1', answeredTextCurrent: null, prose: '我已年满 16 周岁。' }),
      ],
    });
    api.recordConsent.mockResolvedValue({ type: 'pipl_cross_border', granted: true, proseVersion: 'v1', proseHash: 'h', at: 'x', accountClosing: false });
    renderWithBrand(<ConsentsPanel />, { brand: 'goapply' });
    const cross = (await screen.findByText('境外处理方：数据库 Neon。')).closest('li') as HTMLElement;
    expect(cross).toHaveTextContent('This text has changed since you answered. Your answer was given to the earlier version.');
    // Same words (version bump only), a catalog that does not say, or a record that cannot be compared: no note, no extra button.
    for (const type of ['pipl_basic_processing', 'marketing_email', 'age_16_plus']) {
      const row = document.querySelector(`[data-consent="${type}"]`) as HTMLElement;
      expect(row).not.toHaveTextContent('This text has changed');
      expect(within(row).queryByRole('button', { name: 'Agree to this text' })).toBeNull();
    }
    fireEvent.click(within(cross).getByRole('button', { name: 'Agree to this text' }));
    await waitFor(() => expect(api.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipl_cross_border', granted: true, proseVersion: 'v1' })));
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
