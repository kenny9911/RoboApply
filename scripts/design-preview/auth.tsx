import type { ReactNode } from 'react';

// This module is reachable only through the preview bundler's alias.
const session = {
  user: { id: 'design-preview-avery', name: 'Avery Chen', email: 'avery@example.test', role: 'candidate', roles: ['candidate'] },
  profile: { name: 'Avery Chen' },
  onboardingState: { completed: true, completedSteps: ['resume', 'confirm'], autoOpens: 2 },
};
const value = {
  ...session,
  status: 'authenticated' as const,
  refresh: async () => session,
  setSession: () => {},
  clear: () => {},
};

export function AuthProvider({ children }: { children: ReactNode }) { return children; }
export function useAuth() { return value; }
