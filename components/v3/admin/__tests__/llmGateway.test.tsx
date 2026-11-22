// The LLM gateway page (/admin/llm): provider entries and the provider, model,
// reasoning effort and fallback models each functionality area uses. An admin
// sees every area with what its requests resolve to now and where that comes
// from, adds a provider (the key is sent once and never shown again), and
// assigns an area. The API wrapper is mocked; nothing reaches the network.

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithBrand } from '../../../../__tests__/shell/helpers';
import { buildAuthValue, buildFakeUser, mockAuthState } from '../../../../__tests__/utils/mockAuth';

vi.mock('../../../../lib/auth/AuthProvider', () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children, useAuth: () => mockAuthState.value }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/llm', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  saveRoutes: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  fetchModels: vi.fn(),
  testProvider: vi.fn(),
}));
vi.mock('../../../../lib/api/adminLlm', async (orig) => ({ ...(await orig<typeof import('../../../../lib/api/adminLlm')>()), adminLlmApi: api }));

import { LlmGatewayConsole } from '../LlmGatewayConsole';
import { LLM_AREAS, type LlmAreaView, type LlmGatewayOverview, type LlmProviderEntry } from '../../../../lib/api/adminLlm';
import { RoboApiError } from '../../../../lib/api/client';
import en from '../../../../i18n/messages/en.json';

const KEY = 'sk-test-1234567890abcdef';
const admin = () => buildAuthValue({ user: { ...buildFakeUser(), role: 'admin' } as never });

const AIGW: LlmProviderEntry = {
  id: 'aigw', name: 'Aigw', type: 'newapi', baseUrl: 'https://aigw.example.com/v1', effectiveBaseUrl: 'https://aigw.example.com/v1', enabled: true, notes: null,
  hasKey: true, keyPreview: 'sk-t…cdef', keyUnreadable: false, usable: true, models: ['gemini-3.8-flash', 'gpt-6.1-sol'], modelsFetchedAt: '2026-11-22T10:00:00.000Z', updatedAt: '2026-11-22T10:00:00.000Z',
};
const GEMINI: LlmProviderEntry = { ...AIGW, id: 'gemini', name: 'Gemini direct', type: 'google', baseUrl: null, effectiveBaseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-3.8-flash'] };

const SETTINGS: Record<string, string[]> = {
  default: ['defaultModel'], matchResume: ['matching', 'matchResume', 'matchScreen', 'prematchFilter'], parseResume: ['extract', 'resumeTag'], visual: ['vision'],
  evaluation: ['evaluation'], insights: ['insights'], writing: ['writing', 'rewrite'], assistant: ['copilot', 'onboarding', 'intentParser'], jobs: ['enrich', 'jobTag', 'quickJob'],
};

function area(name: (typeof LLM_AREAS)[number], over: Partial<LlmAreaView> = {}): LlmAreaView {
  return {
    area: name, route: null, routeStatus: null, modelListed: null, fallbackStatus: [], fallbackListed: [], inheritsDefault: false,
    needsTools: name === 'assistant', needsImages: name === 'visual',
    keys: SETTINGS[name].map((key) => ({ key, envName: `LLM_${key.toUpperCase()}`, effective: null, source: 'none' as const, via: 'none' as const, shared: false, providerId: null, providerType: null, model: null })),
    ...over,
  };
}

function overview(over: Partial<LlmGatewayOverview> = {}): LlmGatewayOverview {
  return {
    environment: 'production', brand: 'roboapply', dbDisabled: false, encryptionReady: true, maxProviders: 16,
    maxFallbacks: 3, efforts: ['provider', 'minimal', 'low', 'medium', 'high', 'max'], defaultEffort: 'medium',
    providerTypes: [
      { type: 'newapi', baseUrl: 'required', defaultBaseUrl: null, tools: true },
      { type: 'google', baseUrl: 'optional', defaultBaseUrl: 'https://generativelanguage.googleapis.com', tools: false },
      { type: 'openai', baseUrl: 'optional', defaultBaseUrl: 'https://api.openai.com/v1', tools: true },
    ],
    providers: [AIGW, GEMINI],
    areas: LLM_AREAS.map((name) =>
      name === 'default'
        ? area(name, { keys: [{ key: 'defaultModel', envName: 'LLM_MODEL', effective: 'google/gemini-3.8-flash', source: 'env', via: 'env', shared: false, providerId: null, providerType: 'google', model: 'gemini-3.8-flash' }] })
        : name === 'matchResume'
          ? area(name, {
              route: { providerId: 'aigw', model: 'gpt-6.1-sol', effort: 'medium', fallbacks: [] }, routeStatus: 'ok', modelListed: true,
              keys: SETTINGS.matchResume.map((key) => ({ key, envName: 'LLM_MATCHING_MODEL', effective: 'newapi@aigw:matchresume/gpt-6.1-sol', source: 'override' as const, via: 'area' as const, shared: false, providerId: 'aigw', providerType: 'newapi', model: 'gpt-6.1-sol' })),
            })
          : area(name),
    ),
    defaultModel: 'google/gemini-3.8-flash',
    updatedAt: null,
    ...over,
  };
}

const card = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('li') as HTMLElement;
/** A fallback row inside a card ("Fallback 1", …). */
const row = (scope: HTMLElement, n: number) => within(scope).getByText(`Fallback ${n}`).closest('li') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.value = admin();
  api.overview.mockResolvedValue(overview());
});

describe('the LLM gateway page', () => {
  it('lists every area with what its requests use now and where that comes from', async () => {
    renderWithBrand(<LlmGatewayConsole />);
    expect(await screen.findByRole('heading', { level: 1, name: 'LLM gateway' })).toBeInTheDocument();
    await screen.findByRole('heading', { level: 3, name: 'Default' });
    for (const name of LLM_AREAS) expect(card(en.admin.console.llm.area[name].title)).toBeInTheDocument();

    const match = within(card('Match resume'));
    expect(match.getByText('Assigned')).toBeInTheDocument();
    expect(match.getAllByText('gpt-6.1-sol')).toHaveLength(4);
    expect(match.getAllByText("This area's assignment")).toHaveLength(4);

    const def = within(card('Default'));
    expect(def.getByText('Inherits')).toBeInTheDocument();
    expect(def.getByText('Environment variable LLM_MODEL')).toBeInTheDocument();
    // With nothing set, an area uses the default model, never another area's.
    expect(within(card('Visual')).getByText('No model of its own; uses the default model (google/gemini-3.8-flash)')).toBeInTheDocument();
    expect(within(card('Evaluation')).getByText('No model of its own; uses the default model (google/gemini-3.8-flash)')).toBeInTheDocument();
    expect(within(card('Insights')).getByText('No model of its own; uses the default model (google/gemini-3.8-flash)')).toBeInTheDocument();
    // next-intl prints an unknown key as its dotted path: none may show.
    expect(document.body.textContent).not.toMatch(/admin\.console\.llm\./);
  });

  it('shows a provider by name, type, endpoint and key preview, never a key', async () => {
    renderWithBrand(<LlmGatewayConsole />);
    const aigw = within(await waitFor(() => card('Aigw')));
    expect(aigw.getByText('https://aigw.example.com/v1')).toBeInTheDocument();
    expect(aigw.getByText('sk-t…cdef')).toBeInTheDocument();
    expect(aigw.getByText('2 models')).toBeInTheDocument();
    expect(aigw.getByText('Ready')).toBeInTheDocument();
    expect(within(card('Gemini direct')).getByText(/Google Gemini/)).toBeInTheDocument();
  });

  it('adds a provider: the key is sent once, and the result of the model fetch is the new state', async () => {
    api.overview.mockResolvedValue(overview({ providers: [] }));
    api.testProvider.mockResolvedValue({ models: { ok: true, models: ['a', 'b', 'c'], truncated: false, elapsedMs: 120 } });
    api.createProvider.mockResolvedValue({ provider: AIGW, models: { ok: true, models: AIGW.models, truncated: false, elapsedMs: 90 }, overview: overview({ providers: [AIGW] }) });
    renderWithBrand(<LlmGatewayConsole />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    const form = within(screen.getByRole('form', { name: 'Add a provider' }));
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: 'Aigw' } });
    fireEvent.change(form.getByLabelText(/^API base URL/), { target: { value: ' https://aigw.example.com/v1 ' } });
    fireEvent.change(form.getByLabelText(/^API key/), { target: { value: KEY } });
    expect(form.getByLabelText(/^API key/)).toHaveAttribute('type', 'password');

    fireEvent.click(form.getByRole('button', { name: 'Test without saving' }));
    expect(await form.findByText('The provider lists 3 models.')).toBeInTheDocument();
    expect(api.testProvider).toHaveBeenCalledWith({ type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: KEY });

    fireEvent.click(form.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith('roboapply', { name: 'Aigw', type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: KEY, enabled: true, notes: '' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Aigw' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a provider' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('says why a save was refused, in words', async () => {
    api.overview.mockResolvedValue(overview({ providers: [] }));
    api.createProvider.mockRejectedValue(new RoboApiError('conflict', { code: 'duplicate_name', status: 409, payload: { success: false, code: 'duplicate_name' } }));
    renderWithBrand(<LlmGatewayConsole />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    const form = within(screen.getByRole('form', { name: 'Add a provider' }));
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: 'Aigw' } });
    fireEvent.click(form.getByRole('button', { name: 'Save provider' }));
    expect(await form.findByText('Another provider already has this name.')).toBeInTheDocument();
  });

  it('assigns an area to a provider and one of its models at Medium effort, and clears it again', async () => {
    api.saveRoutes.mockResolvedValue(overview());
    renderWithBrand(<LlmGatewayConsole />);
    const insights = within(await waitFor(() => card('Insights')));
    const save = insights.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(insights.getByLabelText('Model')).toBeDisabled();
    expect(insights.queryByText('Fallback models')).not.toBeInTheDocument(); // only for an assignment
    fireEvent.change(insights.getByLabelText('Provider'), { target: { value: 'aigw' } });
    expect(save).toBeDisabled(); // a provider alone is not an assignment
    expect(insights.getByLabelText('Reasoning effort')).toHaveValue('medium');
    fireEvent.change(insights.getByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.saveRoutes).toHaveBeenCalledWith('roboapply', { insights: { providerId: 'aigw', model: 'gemini-3.8-flash', effort: 'medium', fallbacks: [] } }));

    const match = within(card('Match resume'));
    fireEvent.change(match.getByLabelText('Provider'), { target: { value: '' } });
    fireEvent.click(match.getByRole('button', { name: 'Clear assignment' }));
    await waitFor(() => expect(api.saveRoutes).toHaveBeenCalledWith('roboapply', { matchResume: null }));
  });

  it('sets the reasoning effort, and adds, orders and removes fallback models', async () => {
    api.saveRoutes.mockResolvedValue(overview());
    renderWithBrand(<LlmGatewayConsole />);
    const matchEl = await waitFor(() => card('Match resume'));
    const match = within(matchEl);
    expect(match.getAllByLabelText('Reasoning effort')[0]).toHaveValue('medium');
    fireEvent.change(match.getAllByLabelText('Reasoning effort')[0], { target: { value: 'high' } });

    fireEvent.click(match.getByRole('button', { name: 'Add fallback model' }));
    const first = within(row(matchEl, 1));
    const save = match.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // a fallback needs a provider and a model
    fireEvent.change(first.getByLabelText('Provider'), { target: { value: 'gemini' } });
    fireEvent.change(first.getByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } });
    fireEvent.change(first.getByLabelText('Reasoning effort'), { target: { value: 'provider' } });

    fireEvent.click(match.getByRole('button', { name: 'Add fallback model' }));
    const second = within(row(matchEl, 2));
    fireEvent.change(second.getByLabelText('Provider'), { target: { value: 'aigw' } });
    fireEvent.change(second.getByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } });
    // Move the second above the first.
    fireEvent.click(match.getByRole('button', { name: 'Move fallback 2 up' }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.saveRoutes).toHaveBeenCalledWith('roboapply', {
      matchResume: {
        providerId: 'aigw', model: 'gpt-6.1-sol', effort: 'high',
        fallbacks: [
          { providerId: 'aigw', model: 'gemini-3.8-flash', effort: 'medium' },
          { providerId: 'gemini', model: 'gemini-3.8-flash', effort: 'provider' },
        ],
      },
    }));

    fireEvent.click(match.getByRole('button', { name: 'Remove fallback 1' }));
    expect(match.queryByText('Fallback 2')).not.toBeInTheDocument();
    fireEvent.click(match.getByRole('button', { name: 'Add fallback model' }));
    fireEvent.click(match.getByRole('button', { name: 'Add fallback model' }));
    expect(match.getByRole('button', { name: 'Add fallback model' })).toBeDisabled();
    expect(match.getByText('This area has the most fallback models it can take (3).')).toBeInTheDocument();
  });

  it('refuses the same model twice in one area', async () => {
    renderWithBrand(<LlmGatewayConsole />);
    const matchEl = await waitFor(() => card('Match resume'));
    fireEvent.click(within(matchEl).getByRole('button', { name: 'Add fallback model' }));
    const first = within(row(matchEl, 1));
    fireEvent.change(first.getByLabelText('Provider'), { target: { value: 'aigw' } });
    fireEvent.change(first.getByLabelText('Model'), { target: { value: 'gpt-6.1-sol' } });
    expect(within(matchEl).getByText('Each model can be used once in an area.')).toBeInTheDocument();
    expect(within(matchEl).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('does not let the Assistant use a provider type that cannot stream tool calls, for its model or a fallback', async () => {
    renderWithBrand(<LlmGatewayConsole />);
    const assistantEl = await waitFor(() => card('Assistant'));
    const assistant = within(assistantEl);
    fireEvent.change(assistant.getByLabelText('Provider'), { target: { value: 'gemini' } });
    fireEvent.change(assistant.getByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } });
    expect(assistant.getByText(/cannot stream tool calls\./)).toBeInTheDocument();
    expect(assistant.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(assistant.getAllByLabelText('Provider')[0], { target: { value: 'aigw' } });
    fireEvent.change(assistant.getAllByLabelText('Model')[0], { target: { value: 'gpt-6.1-sol' } });
    expect(assistant.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(assistant.getByRole('button', { name: 'Add fallback model' }));
    const first = within(row(assistantEl, 1));
    fireEvent.change(first.getByLabelText('Provider'), { target: { value: 'gemini' } });
    fireEvent.change(first.getByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } });
    expect(assistant.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says when an unassigned area runs on the Default area', async () => {
    api.overview.mockResolvedValue(overview({
      areas: overview().areas.map((a) => (a.area === 'writing'
        ? { ...a, inheritsDefault: true, keys: a.keys.map((k) => ({ ...k, effective: 'newapi@aigw:default/gpt-6.1-sol', source: 'override' as const, via: 'default' as const, providerId: 'aigw', providerType: 'newapi', model: 'gpt-6.1-sol' })) }
        : a)),
    }));
    renderWithBrand(<LlmGatewayConsole />);
    const writing = within(await waitFor(() => card('Writing')));
    expect(writing.getByText('Uses Default')).toBeInTheDocument();
    expect(writing.getAllByText("The Default area's assignment")).toHaveLength(2);
    expect(writing.getByRole('option', { name: 'Not assigned (use Default)' })).toBeInTheDocument();
    expect(within(card('Default')).getByRole('option', { name: 'Not assigned (use the environment)' })).toBeInTheDocument();
  });

  it('shows a saved fallback that cannot be used right now', async () => {
    api.overview.mockResolvedValue(overview({
      areas: overview().areas.map((a) => (a.area === 'matchResume'
        ? { ...a, route: { ...a.route!, fallbacks: [{ providerId: 'gemini', model: 'gemini-3.8-flash', effort: 'low' }] }, fallbackStatus: ['provider_disabled' as const], fallbackListed: [true] }
        : a)),
    }));
    renderWithBrand(<LlmGatewayConsole />);
    const matchEl = await waitFor(() => card('Match resume'));
    const first = within(row(matchEl, 1));
    expect(first.getByLabelText('Provider')).toHaveValue('gemini');
    expect(first.getByLabelText('Reasoning effort')).toHaveValue('low');
    expect(first.getByText(en.admin.console.llm.routeStatus.provider_disabled)).toBeInTheDocument();
    expect(within(matchEl).getByRole('button', { name: 'Save' })).toBeDisabled(); // nothing changed yet
  });

  it('says when an assignment is not in effect, and when saved settings are switched off', async () => {
    api.overview.mockResolvedValue(overview({
      dbDisabled: true,
      areas: overview().areas.map((a) => (a.area === 'matchResume' ? { ...a, routeStatus: 'provider_disabled' as const } : a)),
    }));
    renderWithBrand(<LlmGatewayConsole />);
    const match = within(await waitFor(() => card('Match resume')));
    expect(match.getByText('Not in effect')).toBeInTheDocument();
    expect(match.getByText('The assigned provider is off, so this area uses its inherited model.')).toBeInTheDocument();
    expect(screen.getByText(/LLM_SETTINGS_DB_DISABLED/)).toBeInTheDocument();
  });

  it('shows GoApply its own assignments and says what it inherits', async () => {
    renderWithBrand(<LlmGatewayConsole />);
    fireEvent.change(await screen.findByLabelText('Site'), { target: { value: 'goapply' } });
    await waitFor(() => expect(api.overview).toHaveBeenCalledWith('goapply'));
    expect(await screen.findByText("GoApply reads its own areas and its own Default first. Where it has neither, it uses RoboApply's.")).toBeInTheDocument();
  });

  it('is for admins only', async () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser() as never });
    renderWithBrand(<LlmGatewayConsole />);
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'LLM gateway' })).not.toBeInTheDocument());
    expect(api.overview).not.toHaveBeenCalled();
  });
});
