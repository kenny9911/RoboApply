import type { ReactNode } from 'react';

// Only the ROBOAPPLY_PREVIEW=admin bundler aliases this module. No real auth.
const session = {
  user: { id: 'preview-admin', name: 'Demo Admin', email: 'admin@example.test', role: 'admin', roles: ['admin'] },
  profile: { name: 'Demo Admin' },
  onboardingState: { completed: true, completedSteps: ['resume', 'confirm'], autoOpens: 2 },
};
const value = { ...session, status: 'authenticated' as const, refresh: async () => session, setSession: () => {}, clear: () => {} };
export function AuthProvider({ children }: { children: ReactNode }) { return children; }
export function useAuth() { return value; }
