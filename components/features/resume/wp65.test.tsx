// WP-65 — guided builder (per brand / locale, AI on and off, personal details
// never in a prompt, AiGeneratedBadge on GoApply), fit to one page with undo,
// section order, personal details + photo, the paper preview of the new
// layout keys, the 4-step check tour and the Assistant entry. Renders through
// the real en.json + staged English; any missing key fails the test.

import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '../../../__tests__/utils/renderWithProviders';
import { capsFor } from '../../../__tests__/shell/helpers';
import { BrandProvider } from '../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../lib/brand/client';
import type { BrandId } from '../../../lib/brand/registry.generated';
import { builderConfigFor } from '../../../server/src/features/resume/builder/sections';

const api = vi.hoisted(() => ({
  fitResumeToPage: vi.fn(),
  patchResumeLayout: vi.fn(),
  suggestBuilderText: vi.fn(),
  createResumeFromBuilder: vi.fn(),
  getBuilderConfig: vi.fn(),
}));
vi.mock('../../../lib/api/resumes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api/resumes')>();
  return { ...actual, ...api };
});
const ui = vi.hoisted(() => ({ getUiState: vi.fn(), markToursSeen: vi.fn() }));
vi.mock('../../../lib/api/uiState', () => ui);
const gate = vi.hoisted(() => ({ requestPopup: vi.fn() }));
vi.mock('../../../lib/ui/popupGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ui/popupGate')>();
  return { ...actual, requestPopup: gate.requestPopup };
});
const assistant = vi.hoisted(() => ({ open: vi.fn(() => true) }));
vi.mock('../../../hooks/shared/useOpenAssistant', () => ({ useOpenAssistant: () => assistant.open }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/resume/new' }));

import { ResumeBuilderView } from './builder/ResumeBuilder';
import { toRequest, blankDraft, draftStorageKey, loadLocalDraft, saveLocalDraft } from './builder/draft';
import { clearResumeBuilderDeviceData, draftPhotoId, readStoredPhoto, writeStoredPhoto } from '../../../hooks/resume/useResumePhoto';
import { AskAssistantButton, FitToPageControl, ResumeDetailsPanel, SectionOrderPanel, docLanguageOf, personalLineFor } from './EditorTools';
import { ResumeTour, ResumeTourCard, RESUME_TOUR_STEPS } from './ResumeTour';
import { LayoutPanel } from './LayoutPanel';
import { layoutPatch, resolveLayout } from './layout';
import { ResumePaper, withEduOrder } from '../../v3/resume-editor/ResumePaper';
import { parseResumeMarkdown, sectionSequence, serializeResumeMarkdown } from '../../../lib/resumeStructure';
import type { BuilderConfig } from '../../../lib/api/resumes';

function render(node: ReactElement, opts: { brand?: BrandId; flags?: Record<string, boolean>; locale?: string } = {}) {
  const errors: unknown[] = [];
  const brand = opts.brand ?? 'roboapply';
  const result = renderWithProviders(
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, opts.flags ?? {})}>
      {node}
    </BrandProvider>,
    { intlLocale: opts.locale, onIntlError: (e) => errors.push(e) },
  );
  return { ...result, errors };
}

const configFor = (market: 'intl' | 'cn', locale: string, aiAvailable: boolean) =>
  builderConfigFor({ market, locale, page: market === 'cn' ? 'a4' : 'letter', aiAvailable }) as BuilderConfig;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  ui.getUiState.mockReset();
  ui.markToursSeen.mockReset();
  gate.requestPopup.mockReset();
  assistant.open.mockClear();
  try {
    window.localStorage.clear();
  } catch {
    /* storage unavailable */
  }
});
afterEach(() => {
  vi.useRealTimers();
});

const nav = () => screen.getByRole('navigation', { name: 'Builder steps' });
const goToStep = (name: RegExp | string) => fireEvent.click(within(nav()).getByRole('button', { name }));

// ── Guided builder ──────────────────────────────────────────────────────

describe('guided builder per brand and locale', () => {
  it.each([
    ['RoboApply (en)', 'intl', 'en', 'roboapply'],
    ['RoboApply (zh-TW)', 'intl', 'zh-TW', 'roboapply'],
    ['GoApply (zh)', 'cn', 'zh', 'goapply'],
  ] as const)('%s: every step renders with no missing text', (_label, market, locale, brand) => {
    const config = configFor(market, locale, true);
    const { errors } = render(<ResumeBuilderView config={config} onCreated={vi.fn()} />, { brand });
    const buttons = within(nav()).getAllByRole('button');
    expect(buttons).toHaveLength(config.steps.length + 1);
    for (const b of buttons) {
      fireEvent.click(b);
      expect(document.body.textContent).not.toMatch(/resumeBuilder\./);
    }
    expect(errors).toEqual([]);
  });

  it('RoboApply en starts with the job you want; no photo or personal details step', () => {
    render(<ResumeBuilderView config={configFor('intl', 'en', true)} onCreated={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('The job you want');
    expect(within(nav()).queryByRole('button', { name: /Photo and personal details/ })).toBeNull();
  });

  it('GoApply: the 应届 steps (internship, projects, campus, certificates, awards, about me, personal)', () => {
    render(<ResumeBuilderView config={configFor('cn', 'zh', true)} onCreated={vi.fn()} />, { brand: 'goapply' });
    for (const name of ['Internships', 'Projects', 'Campus activities', 'Certificates and skills', 'Awards', 'About me', 'Photo and personal details']) {
      expect(within(nav()).getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
    goToStep(/Photo and personal details/);
    expect(screen.getByLabelText('Native place')).toBeInTheDocument();
    expect(screen.getByLabelText('Political status')).toBeInTheDocument();
    expect(screen.getByText(/never sent to an AI model/)).toBeInTheDocument();
  });

  it('without AI the builder works the same and offers no AI action', async () => {
    api.createResumeFromBuilder.mockResolvedValue({ resumeId: 'new1' });
    const onCreated = vi.fn();
    render(<ResumeBuilderView config={configFor('intl', 'en', false)} onCreated={onCreated} />);
    goToStep(/Work experience/);
    expect(screen.getByText(/Writing help is off/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suggest/ })).toBeNull();
    goToStep(/Summary/);
    expect(screen.queryByRole('button', { name: /Suggest/ })).toBeNull();

    goToStep(/The job you want/);
    fireEvent.change(screen.getByLabelText('Job title you want'), { target: { value: 'Data analyst' } });
    goToStep(/Contact details/);
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Ada Li' } });
    goToStep(/Review/);
    fireEvent.click(screen.getByRole('button', { name: 'Create resume' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new1'));
    expect(api.suggestBuilderText).not.toHaveBeenCalled();
    const body = api.createResumeFromBuilder.mock.calls[0]![0];
    expect(body.basics.fullName).toBe('Ada Li');
    expect(body.intent.targetTitle).toBe('Data analyst');
    expect(body.personal).toBeUndefined();
    expect(body.aiAssisted).toBe(false);
  });

  it('a missing name stops at the step with a plain message', () => {
    render(<ResumeBuilderView config={configFor('intl', 'en', true)} onCreated={vi.fn()} />);
    goToStep(/Review/);
    fireEvent.click(screen.getByRole('button', { name: 'Create resume' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Add (your full name|the job title you want)/);
    expect(api.createResumeFromBuilder).not.toHaveBeenCalled();
  });

  it('GoApply: AI suggestions carry the AI badge; personal details never reach the suggestion request', async () => {
    api.suggestBuilderText.mockResolvedValue({ suggestions: [{ text: '负责校园活动宣传，撰写推文 12 篇', aiWritten: true }], blocked: 1 });
    api.createResumeFromBuilder.mockResolvedValue({ resumeId: 'cn1' });
    const onCreated = vi.fn();
    render(<ResumeBuilderView config={configFor('cn', 'zh', true)} onCreated={onCreated} />, { brand: 'goapply' });

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: '王小明' } });
    goToStep(/Photo and personal details/);
    fireEvent.change(screen.getByLabelText('Native place'), { target: { value: '浙江杭州' } });
    fireEvent.change(screen.getByLabelText('Political status'), { target: { value: '共青团员' } });
    goToStep(/The job you want/);
    fireEvent.change(screen.getByLabelText('Job title you want'), { target: { value: '新媒体运营' } });

    goToStep(/Campus activities/);
    fireEvent.change(screen.getByLabelText('What did you do here?'), { target: { value: '学生会宣传部，写了 12 篇推文' } });
    fireEvent.click(screen.getByRole('button', { name: /Suggest bullet points/ }));
    await screen.findByText('负责校园活动宣传，撰写推文 12 篇');
    expect(document.querySelector('[data-ai-label="text"]')).not.toBeNull();
    expect(screen.getByText(/1 suggestion was left out/)).toBeInTheDocument();
    const sent = JSON.stringify(api.suggestBuilderText.mock.calls);
    for (const secret of ['浙江杭州', '共青团员', '王小明']) expect(sent).not.toContain(secret);
    fireEvent.click(screen.getByRole('button', { name: /^Add: 负责/ }));

    goToStep(/Review/);
    fireEvent.click(screen.getByRole('button', { name: 'Create resume' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('cn1'));
    const body = api.createResumeFromBuilder.mock.calls[0]![0];
    expect(body.personal).toEqual({ nativePlace: '浙江杭州', politicalStatus: '共青团员' });
    expect(body.aiAssisted).toBe(true);
    expect(body.campus[0].bullets).toContain('负责校园活动宣传，撰写推文 12 篇');
  });

  it('RoboApply: the same suggestion shows no GoApply badge', async () => {
    api.suggestBuilderText.mockResolvedValue({ suggestions: [{ text: 'Built a dashboard for the team', aiWritten: true }], blocked: 0 });
    render(<ResumeBuilderView config={configFor('intl', 'en', true)} onCreated={vi.fn()} />);
    goToStep(/Work experience/);
    fireEvent.change(screen.getByLabelText('What did you do here?'), { target: { value: 'made a dashboard' } });
    fireEvent.click(screen.getByRole('button', { name: /Suggest bullet points/ }));
    await screen.findByText('Built a dashboard for the team');
    expect(screen.getByText(/Written by AI from your notes/)).toBeInTheDocument();
    expect(document.querySelector('[data-ai-label]')).toBeNull();
  });

  it('toRequest sends personal details only where the brand offers them', () => {
    const d = { ...blankDraft('zh'), personal: { nativePlace: '浙江', politicalStatus: '' } };
    d.basics = { ...d.basics, fullName: 'A' };
    expect(toRequest(d, { personal: false, photoOffered: false }).personal).toBeUndefined();
    expect(toRequest(d, { personal: true, photoOffered: true }).personal).toEqual({ nativePlace: '浙江' });
  });
});

// ── Unsent draft on a shared browser, AI provenance ─────────────────────

const PHOTO_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==';

describe('builder draft kept per user on this browser', () => {
  const named = (fullName: string) => {
    const d = blankDraft('en');
    d.basics = { ...d.basics, fullName, email: `${fullName.toLowerCase()}@example.test`, phone: '555 0100' };
    return d;
  };

  it('a draft saved by one user is never loaded for another, and nothing is kept without a user', () => {
    saveLocalDraft('user_a', named('Alice'));
    expect(loadLocalDraft('user_a')?.basics?.fullName).toBe('Alice');
    expect(loadLocalDraft('user_b')).toBeNull();
    expect(loadLocalDraft(null)).toBeNull();
    saveLocalDraft(null, named('Nobody'));
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('ra_resume_builder_draft'))).toEqual([draftStorageKey('user_a')]);
  });

  it('when user B opens the builder, user A\'s draft and draft photo are removed and not shown', () => {
    saveLocalDraft('user_a', named('Alice'));
    window.localStorage.setItem('ra_resume_builder_draft', JSON.stringify(named('Legacy')));
    writeStoredPhoto(draftPhotoId('user_a'), PHOTO_URL);
    writeStoredPhoto('draft', PHOTO_URL);
    render(<ResumeBuilderView config={configFor('intl', 'en', false)} onCreated={vi.fn()} userId="user_b" />);
    goToStep(/Contact details/);
    expect((screen.getByLabelText('Full name') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('alice@example.test');
    expect(window.localStorage.getItem(draftStorageKey('user_a'))).toBeNull();
    expect(window.localStorage.getItem('ra_resume_builder_draft')).toBeNull();
    expect(readStoredPhoto(draftPhotoId('user_a'))).toBeNull();
    expect(readStoredPhoto('draft')).toBeNull();
  });

  it('the same user gets their own draft back', () => {
    saveLocalDraft('user_a', named('Alice'));
    render(<ResumeBuilderView config={configFor('intl', 'en', false)} onCreated={vi.fn()} userId="user_a" />);
    goToStep(/Contact details/);
    expect((screen.getByLabelText('Full name') as HTMLInputElement).value).toBe('Alice');
  });

  it('after a create the draft photo is removed even when the user unticked the photo', async () => {
    api.createResumeFromBuilder.mockResolvedValue({ resumeId: 'new_tw' });
    writeStoredPhoto(draftPhotoId('user_a'), PHOTO_URL);
    const onCreated = vi.fn();
    const d = named('Alice');
    d.intent = { ...d.intent, targetTitle: 'Analyst' };
    d.photo = false;
    saveLocalDraft('user_a', d);
    render(<ResumeBuilderView config={configFor('intl', 'zh-TW', false)} onCreated={onCreated} userId="user_a" />);
    goToStep(/Review|檢查/);
    fireEvent.click(screen.getByRole('button', { name: /Create resume|建立/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new_tw'));
    expect(api.createResumeFromBuilder.mock.calls[0]![0].photo).toBe(false);
    expect(readStoredPhoto(draftPhotoId('user_a'))).toBeNull();
    expect(readStoredPhoto('new_tw')).toBeNull();
    expect(window.localStorage.getItem(draftStorageKey('user_a'))).toBeNull();
  });

  it('sign-out cleanup removes every builder draft and draft photo', () => {
    saveLocalDraft('user_a', named('Alice'));
    writeStoredPhoto(draftPhotoId('user_a'), PHOTO_URL);
    writeStoredPhoto('resume_1', PHOTO_URL);
    clearResumeBuilderDeviceData();
    expect(window.localStorage.getItem(draftStorageKey('user_a'))).toBeNull();
    expect(readStoredPhoto(draftPhotoId('user_a'))).toBeNull();
    expect(readStoredPhoto('resume_1')).toBe(PHOTO_URL);
    clearResumeBuilderDeviceData({ resumePhotos: true });
    expect(readStoredPhoto('resume_1')).toBeNull();
  });

  it('aiAssisted stays true after the user edits an added AI suggestion', () => {
    const d = named('Alice');
    const ai = 'Built a weekly sales dashboard for the team';
    d.experience = [{ ...d.experience[0]!, title: 'Analyst', bullets: [ai] }];
    d.aiTexts = [ai];
    expect(toRequest(d, { personal: false, photoOffered: false }).aiAssisted).toBe(true);
    d.experience = [{ ...d.experience[0]!, bullets: ['Built a weekly sales dashboard for my team.'] }];
    expect(toRequest(d, { personal: false, photoOffered: false }).aiAssisted).toBe(true);
    d.experience = [{ ...d.experience[0]!, bullets: [] }];
    expect(toRequest(d, { personal: false, photoOffered: false }).aiAssisted).toBe(true);
    expect(toRequest(named('Bob'), { personal: false, photoOffered: false }).aiAssisted).toBe(false);
  });
});

// ── Fit to page ─────────────────────────────────────────────────────────

const SIZES = { name: 22, section: 12, sub: 11, body: 10.5 };
const SPACING = { section: 14, entry: 8, line: 1.25, marginX: 54, marginY: 48 };
const RESTORE_SIZES = { name: 20, section: null, sub: null, body: null };
const RESTORE_SPACING = { section: null, entry: null, line: null, marginX: null, marginY: null };

describe('fit to one page', () => {
  it('fits, says only spacing / margins / size changed, and undoes to the previous values', async () => {
    api.fitResumeToPage.mockResolvedValue({
      status: 'fitted',
      pages: { before: 2, after: 1, target: 1 },
      applied: { sizes: { ...SIZES, body: 10 }, spacing: { ...SPACING, section: 10 } },
      previous: { sizes: SIZES, spacing: SPACING },
      restore: { sizes: RESTORE_SIZES, spacing: RESTORE_SPACING },
    });
    api.patchResumeLayout.mockResolvedValue({ id: 'r1' });
    render(<FitToPageControl resumeId="r1" />);
    expect(screen.queryByRole('button', { name: 'Fit on two pages' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fit on one page' }));
    await screen.findByText(/Now fits on 1 page\. Only spacing, margins and text size changed\./);
    expect(api.fitResumeToPage).toHaveBeenCalledWith('r1', { pages: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText(/back to how they were/);
    // Undo sends the stored values (null = remove what the fit added), never the template defaults.
    expect(api.patchResumeLayout).toHaveBeenCalledWith('r1', { layout: { sizes: RESTORE_SIZES, spacing: RESTORE_SPACING } });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('too long: changes nothing and offers no undo; GoApply can target two pages', async () => {
    api.fitResumeToPage.mockResolvedValue({
      status: 'too_long',
      pages: { before: 3, after: 3, target: 2 },
      applied: null,
      previous: { sizes: SIZES, spacing: SPACING },
      restore: { sizes: RESTORE_SIZES, spacing: RESTORE_SPACING },
    });
    render(<FitToPageControl resumeId="r1" maxPages={2} photo />);
    fireEvent.click(screen.getByRole('button', { name: 'Fit on two pages' }));
    await screen.findByText(/Too long to fit on 2 pages without removing text\. Nothing changed\./);
    // A placed device photo is reserved while counting pages.
    expect(api.fitResumeToPage).toHaveBeenCalledWith('r1', { pages: 2, photo: true });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

// ── Section order, details, preview ─────────────────────────────────────

const MD = `# Ada Li
Data analyst · ada@example.com

## Summary
Analyst who likes clean data.

## Experience
### Analyst — Acme
- Built weekly reports

## Education
### State University
BSc Statistics

## Skills
SQL, Python
`;

describe('section order', () => {
  it('moves a section without changing any text', () => {
    const resume = parseResumeMarkdown(MD);
    const onChange = vi.fn();
    render(<SectionOrderPanel resume={resume} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Education up' }));
    const next = onChange.mock.calls[0]![0];
    const keys = sectionSequence(next).map((r: { kind: string; key?: string }) => r.key);
    expect(keys.indexOf('education')).toBeLessThan(keys.indexOf('experiences'));
    // Same sections, same text — only their order differs.
    const blocks = (md: string) => md.split(/^## /m).map((b) => b.trim()).sort();
    expect(blocks(serializeResumeMarkdown(next))).toEqual(blocks(serializeResumeMarkdown(resume)));
    expect(serializeResumeMarkdown(next)).not.toEqual(serializeResumeMarkdown(resume));
    expect(screen.getByRole('button', { name: 'Move Summary up' })).toBeDisabled();
  });
});

describe('personal details and photo', () => {
  it('saves on blur, clears with null, and toggles the photo', () => {
    const onPatch = vi.fn();
    const photo = { photo: null, save: vi.fn(), remove: vi.fn() };
    render(<ResumeDetailsPanel layout={{ personal: { nativePlace: '浙江' } }} personalFields={['nativePlace', 'politicalStatus']} photoOffered photo={photo} onPatch={onPatch} />, {
      brand: 'goapply',
    });
    const status = screen.getByLabelText('Political status');
    fireEvent.change(status, { target: { value: '群众' } });
    fireEvent.blur(status);
    expect(onPatch).toHaveBeenLastCalledWith({ personal: { nativePlace: '浙江', politicalStatus: '群众' } });
    const place = screen.getByLabelText('Native place');
    fireEvent.change(place, { target: { value: '' } });
    fireEvent.change(status, { target: { value: '' } });
    fireEvent.blur(place);
    expect(onPatch).toHaveBeenLastCalledWith({ personal: null });
    fireEvent.click(screen.getByRole('checkbox', { name: /Add my photo/ }));
    expect(onPatch).toHaveBeenLastCalledWith({ photo: false });
    expect(screen.getByText(/never saved on our servers/)).toBeInTheDocument();
  });

  it('prints the details line with the export labels', () => {
    expect(personalLineFor({ nativePlace: '浙江杭州', politicalStatus: '中共党员' }, 'zh')).toBe('籍贯：浙江杭州 ｜ 政治面貌：中共党员');
    expect(personalLineFor({ nativePlace: 'Hangzhou' }, 'en')).toBe('Native place: Hangzhou');
    expect(personalLineFor({}, 'zh')).toBeNull();
    expect(personalLineFor(null, 'zh')).toBeNull();
    expect(docLanguageOf('as_written', '王小明 实习经历')).toBe('zh');
    expect(docLanguageOf('as_written', 'Ada Li')).toBe('en');
    expect(docLanguageOf('as_written', '實習經歷')).toBe('zh-TW');
    expect(docLanguageOf('en', '王小明')).toBe('en');
  });
});

describe('paper preview (WP-65 layout keys)', () => {
  it('shows the details line and the device photo, and follows education order and bullets', () => {
    const resume = parseResumeMarkdown(MD);
    const layout = resolveLayout({ eduOrder: 'before_experience', bullet: 'dash', justify: true }, 'a4');
    render(<ResumePaper resume={resume} layout={layout} personalLine="籍贯：浙江" photo="data:image/jpeg;base64,AAAA" photoAlt="Your resume photo" />);
    expect(screen.getByTestId('paper-personal')).toHaveTextContent('籍贯：浙江');
    expect(screen.getByRole('img', { name: 'Your resume photo' })).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles.indexOf('Education')).toBeLessThan(titles.indexOf('Experience'));
    expect(document.querySelector('.rb-paper-bullets')).toHaveStyle({ listStyleType: '"– "' });
  });

  it('withEduOrder leaves the order alone when it already matches or one block is missing', () => {
    expect(withEduOrder(['summary', 'experiences', 'education', 'skills'], 'after_experience')).toEqual(['summary', 'experiences', 'education', 'skills']);
    expect(withEduOrder(['summary', 'experiences', 'education', 'skills'], 'before_experience')).toEqual(['summary', 'education', 'experiences', 'skills']);
    expect(withEduOrder(['education', 'experiences'], 'after_experience')).toEqual(['experiences', 'education']);
    expect(withEduOrder(['summary', 'skills'], 'before_experience')).toEqual(['summary', 'skills']);
  });
});

describe('layout panel additions', () => {
  it('offers bullet, justify, education order, skills layout and section-title language', () => {
    const onChange = vi.fn();
    render(<LayoutPanel value={resolveLayout(null, 'a4')} defaultPage="a4" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dash' }));
    expect(onChange).toHaveBeenLastCalledWith({ bullet: 'dash' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Line up text on both sides' }));
    expect(onChange).toHaveBeenLastCalledWith({ justify: true });
    fireEvent.change(screen.getByLabelText('Section titles in the downloaded file'), { target: { value: 'zh' } });
    expect(onChange).toHaveBeenLastCalledWith({ headingLanguage: 'zh' });
    fireEvent.change(screen.getByLabelText('Skills'), { target: { value: 'columns' } });
    expect(onChange).toHaveBeenLastCalledWith({ skillsLayout: 'columns' });
    expect(layoutPatch({ eduOrder: 'as_written' })).toEqual({ eduOrder: null });
    expect(layoutPatch({ eduOrder: 'after_experience' })).toEqual({ eduOrder: 'after_experience' });
  });
});

// ── Tour ────────────────────────────────────────────────────────────────

describe('resume check tour (4 steps)', () => {
  it('walks the four parts, outlines each one, and Escape ends it', () => {
    document.body.innerHTML = RESUME_TOUR_STEPS.map((s) => `<div data-tour="${s}"></div>`).join('');
    const onStep = vi.fn();
    const onFinish = vi.fn();
    const { rerender, errors } = render(<ResumeTourCard step={0} onStep={onStep} onFinish={onFinish} />);
    expect(screen.getByText('1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your grade' })).toBeInTheDocument();
    expect(document.querySelector('[data-tour="grade"]')).toHaveAttribute('data-tour-active', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onStep).toHaveBeenCalledWith(1);
    rerender(
      <BrandProvider brand={clientBrandFor('roboapply')} initialCapabilities={capsFor('roboapply', {})}>
        <ResumeTourCard step={3} onStep={onStep} onFinish={onFinish} />
      </BrandProvider>,
    );
    expect(document.querySelector('[data-tour="grade"]')).not.toHaveAttribute('data-tour-active');
    expect(document.querySelector('[data-tour="recheck"]')).toHaveAttribute('data-tour-active', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onFinish).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it('starts once through the popup gate and stores "seen" for the user', async () => {
    ui.getUiState.mockResolvedValue({ state: { tours: {} } });
    ui.markToursSeen.mockResolvedValue({ state: { tours: { 'resume.checkTour': '2026-10-10T00:00:00.000Z' } } });
    gate.requestPopup.mockResolvedValue(true);
    render(<ResumeTour enabled />);
    await screen.findByTestId('resume-tour');
    expect(gate.requestPopup).toHaveBeenCalledWith('tour:resume.checkTour', 'announcement');
    fireEvent.click(screen.getByRole('button', { name: 'End tour' }));
    await waitFor(() => expect(ui.markToursSeen).toHaveBeenCalledWith(['resume.checkTour']));
    expect(screen.queryByTestId('resume-tour')).toBeNull();
  });

  it('once seen it does not start by itself; "Show me around" replays it', async () => {
    ui.getUiState.mockResolvedValue({ state: { tours: { 'resume.checkTour': '2026-10-01T00:00:00.000Z' } } });
    render(<ResumeTour enabled />);
    await waitFor(() => expect(ui.getUiState).toHaveBeenCalled());
    await act(async () => {});
    expect(gate.requestPopup).not.toHaveBeenCalled();
    expect(screen.queryByTestId('resume-tour')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show me around' }));
    expect(screen.getByTestId('resume-tour')).toBeInTheDocument();
  });

  it('renders nothing while the report is not on screen', () => {
    render(<ResumeTour enabled={false} />);
    expect(screen.queryByRole('button', { name: 'Show me around' })).toBeNull();
    expect(ui.getUiState).not.toHaveBeenCalled();
  });
});

// ── Assistant entry ─────────────────────────────────────────────────────

describe('Ask the Assistant about this resume', () => {
  it('opens the Assistant with a prefilled resume request when the Assistant is on', () => {
    render(<AskAssistantButton resumeId="r1" />, { flags: { copilot: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask the Assistant about this resume' }));
    expect(assistant.open).toHaveBeenCalledWith({ source: 'resume', resumeId: 'r1', scope: 'resume', prompt: "I'm editing my resume. Help me improve it." });
  });

  it('the rail receives the resume id with the request', async () => {
    const actual = await vi.importActual<typeof import('../../../hooks/shared/useOpenAssistant')>('../../../hooks/shared/useOpenAssistant');
    assistant.open.mockImplementationOnce((req?: unknown) => {
      actual.openAssistantRail(req as Parameters<typeof actual.openAssistantRail>[0]);
      return true;
    });
    render(<AskAssistantButton resumeId="resume_42" />, { flags: { copilot: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask the Assistant about this resume' }));
    const rail = renderHook(() => actual.useAssistantRail());
    expect(rail.result.current.open).toBe(true);
    expect(rail.result.current.request).toMatchObject({ source: 'resume', resumeId: 'resume_42', scope: 'resume' });
    act(() => actual.closeAssistantRail());
  });

  it('is hidden when the Assistant is off or AI is unavailable', () => {
    const { unmount } = render(<AskAssistantButton resumeId="r1" />, { flags: { copilot: false } });
    expect(screen.queryByRole('button', { name: /Ask the Assistant/ })).toBeNull();
    unmount();
    render(<AskAssistantButton resumeId="r1" enabled={false} />, { flags: { copilot: true } });
    expect(screen.queryByRole('button', { name: /Ask the Assistant/ })).toBeNull();
  });
});
