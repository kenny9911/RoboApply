// roboapply/lib/mock/dimensionLabels.ts
//
// Normalizes a scorecard dimension key to the canonical camelCase enum so the
// report page can localize it via t(`report.dim.${key}`). Handles the legacy
// English keys the deterministic scorer still emits (e.g. "Role fit") so a
// pre-enrichment / fallback report renders translated labels too.

import type { IEDimensionKey } from '../api/interviewEngine';

const CANON: IEDimensionKey[] = ['structure', 'specificity', 'communication', 'confidence', 'roleFit'];

const LEGACY: Record<string, IEDimensionKey> = {
  Structure: 'structure',
  Specificity: 'specificity',
  Communication: 'communication',
  Confidence: 'confidence',
  'Role fit': 'roleFit',
  'Role Fit': 'roleFit',
  'Role-fit': 'roleFit',
};

export function canonicalDimKey(raw: string): IEDimensionKey | null {
  if (!raw) return null;
  if (LEGACY[raw]) return LEGACY[raw];
  const lower = raw.toLowerCase();
  return CANON.find((d) => d.toLowerCase() === lower) ?? null;
}
