/**
 * Brand configuration — single source of truth for white-label deployment.
 *
 * One BrandConfig object per brand, selected at deploy time via the `BRAND`
 * env var. Backend code that needs brand-aware behavior (email From: headers,
 * agent system prompts, JSON-LD organization) reads from getActiveBrand().
 *
 * The same shape exists in frontend/src/brands/types.ts. Keep them in sync
 * until phase 2 extracts to a shared workspace package.
 */
export type BrandId = 'robohire' | 'gohire';

export interface BrandFeatureFlags {
  agentAlexVoice: boolean;
  stripeCheckout: boolean;
  seekerApp: boolean;
  fileVault: boolean;
  autoLoader: boolean;
  assessments: boolean;
  marketIntelligence: boolean;
  multiLanguage: boolean;
  apiPlayground: boolean;
  docsHub: boolean;
  agents: boolean;
  autoPilot: boolean;
}

export interface BrandSeoConfig {
  defaultTitle: string;
  defaultDescription: string;
  defaultKeywords: string;
  twitterHandle?: string;
  organizationFoundingYear?: string;
  organizationSameAs: string[];
}

export interface BrandConfig {
  id: BrandId;
  name: string;
  shortName: string;
  tagline: string;

  // Visual assets — paths under /public on the frontend, absolute when
  // emitted in emails (prepend canonicalHost).
  logoUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  ogImageUrl: string;
  themeColor: string;
  /** Sidebar logo height in px when sidebar is expanded. RoboHire wordmark is wide, so 28 fits; GoHire's stacked mark needs more vertical room. */
  navLogoHeightPx: number;
  /** Sidebar logo height in px when sidebar is collapsed. */
  navLogoHeightCollapsedPx: number;
  /** Logo height in px on marketing + auth surfaces (homepage navbar/footer, login, auth modal). Lets a visually-smaller mark render larger. */
  marketingLogoHeightPx: number;

  primaryColor: string;
  accentColor: string;

  supportEmail: string;
  salesEmail: string;
  emailFromName: string;
  emailFromAddress: string;
  legalEntityName: string;
  termsUrl: string;
  privacyUrl: string;

  /** Canonical WEB origin (the marketing/app site), e.g. https://robohire.io. Used for SEO canonical/OG URLs + JSON-LD. */
  canonicalHost: string;
  /** Canonical API origin shown in the docs/playground examples, e.g. https://api.robohire.io. Frontend build-time fallback for useDocsApiBase(); the runtime VITE_API_URL takes precedence. */
  apiHost: string;
  seo: BrandSeoConfig;

  features: BrandFeatureFlags;
}
