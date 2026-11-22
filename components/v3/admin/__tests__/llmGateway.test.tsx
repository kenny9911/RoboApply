// The LLM gateway page (/admin/llm): provider entries and the provider and
// model each functionality area uses. An admin sees every area with what its
// requests resolve to now and where that comes from, adds a provider (the key
// is sent once and never shown again), and assigns an area. The API wrapper is
// mocked; nothing reaches the network.

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
    area: name, route: null, routeStatus: null, modelListed: null, needsTools: name === 'assistant', needsImages: name === 'visual',
    keys: SETTINGS[name].map((key) => ({ key, envName: `LLM_${key.toUpperCase()}`, effective: null, source: 'none' as const, providerId: null, providerType: null, model: null })),
    ...over,
  };
}

function overview(over: Partial<LlmGatewayOverview> = {}): LlmGatewayOverview {
  return {
    environment: 'production', brand: 'roboapply', dbDisabled: false, encryptionReady: true, maxProviders: 16,
    providerTypes: [
      { type: 'newapi', baseUrl: 'required', defaultBaseUrl: null, tools: true },
      { type: 'google', baseUrl: 'optional', defaultBaseUrl: 'https://generativelanguage.googleapis.com', tools: false },
      { type: 'openai', baseUrl: 'optional', defaultBaseUrl: 'https://api.openai.com/v1', tools: true },
    ],
    providers: [AIGW, GEMINI],
    areas: LLM_AREAS.map((name) =>
      name === 'default'
        ? area(name, { keys: [{ key: 'defaultModel', envName: 'LLM_MODEL', effective: 'google/gemini-3.8-flash', source: 'env', providerId: null, providerType: 'google', model: 'gemini-3.8-flash' }] })
        : name === 'matchResume'
          ? area(name, {
              route: { providerId: 'aigw', model: 'gpt-6.1-sol' }, routeStatus: 'ok', modelListed: true,
              keys: SETTINGS.matchResume.map((key) => ({ key, envName: 'LLM_MATCHING_MODEL', effective: 'newapi@aigw/gpt-6.1-sol', source: 'override' as const, providerId: 'aigw', providerType: 'newapi', model: 'gpt-6.1-sol' })),
            })
          : area(name),
    ),
    defaultModel: 'google/gemini-3.8-flash',
    updatedAt: null,
    ...over,
  };
}

const card = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('li') as HTMLElement;

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
    expect(within(card('Visual')).getByText('No model of its own; uses the Parse resume model')).toBeInTheDocument();
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

  it('assigns an area to a provider and one of its models, and clears it again', async () => {
    api.saveRoutes.mockResolvedValue(overview());
    renderWithBrand(<LlmGatewayConsole />);
    const insights = within(await waitFor(() => card('Insights')));
    const save = insights.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(insights.getByLabelText('Model')).toBeDisabled();
    fireEvent.change(insights.getByLabelText('Provider'), { target: { value: 'aigw' } });
    expect(save).toBeDisabled(); // a provider alone is not an assignment
    fireEvent.change(insights.getByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.saveRoutes).toHaveBeenCalledWith('roboapply', { insights: { providerId: 'aigw', model: 'gemini-3.8-flash' } }));

    const match = within(card('Match resume'));
    fireEvent.change(match.getByLabelText('Provider'), { target: { value: '' } });
    fireEvent.click(match.getByRole('button', { name: 'Clear assignment' }));
    await waitFor(() => expect(api.saveRoutes).toHaveBeenCalledWith('roboapply', { matchResume: null }));
  });

  it('does not let the Assistant be assigned to a provider type that cannot stream tool calls', async () => {
    renderWithBrand(<LlmGatewayConsole />);
    const assistant = within(await waitFor(() => card('Assistant')));
    fireEvent.change(assistant.getByLabelText('Provider'), { target: { value: 'gemini' } });
    fireEvent.change(assistant.getByLabelText('Model'), { target: { value: 'gemini-3.8-flash' } });
    expect(assistant.getByText(/cannot stream tool calls here/)).toBeInTheDocument();
    expect(assistant.getByRole('button', { name: 'Save' })).toBeDisabled();
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
    expect(await screen.findByText("GoApply uses RoboApply's assignment for any area it does not assign itself.")).toBeInTheDocument();
  });

  it('is for admins only', async () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser() as never });
    renderWithBrand(<LlmGatewayConsole />);
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: 'LLM gateway' })).not.toBeInTheDocument());
    expect(api.overview).not.toHaveBeenCalled();
  });
});
