// server/src/features/compliance/kinds.ts — queue work kinds of the compliance
// area (kept apart from workers.ts so producers do not import the workers).

export const COMPLIANCE_WORK_KINDS = { dataExport: 'compliance.export', retentionPurge: 'compliance.purge' } as const;
