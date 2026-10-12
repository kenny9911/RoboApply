'use client';

// hooks/resume/useFitToPage.ts — fit a resume on one page (GoApply: up to 2)
// by adjusting spacing, margins and type sizes only, with undo (WP-65;
// PRODUCT_PLAN.md F-RES-14). Undo PATCHes the stored values back (`restore`:
// null removes a value the fit added, so template defaults are not pinned).

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { fitResumeToPage, patchResumeLayout, type FitToPageResponse } from '../../lib/api/resumes';

const detailKey = (id: string) => ['v2', 'resumes', 'detail', id] as const;

export function useFitToPage(id: string) {
  const qc = useQueryClient();
  const [last, setLast] = useState<FitToPageResponse | null>(null);

  const fit = useMutation<FitToPageResponse, unknown, { pages: 1 | 2; photo?: boolean }>({
    mutationFn: ({ pages, photo }) => fitResumeToPage(id, photo ? { pages, photo: true } : { pages }),
    onSuccess: (res) => {
      setLast(res);
      if (res.applied) void qc.invalidateQueries({ queryKey: detailKey(id) });
    },
  });

  const undo = useMutation<unknown, unknown, void>({
    mutationFn: async () => {
      if (!last?.applied) return null;
      return patchResumeLayout(id, { layout: { sizes: last.restore.sizes, spacing: last.restore.spacing } });
    },
    onSuccess: () => {
      setLast(null);
      void qc.invalidateQueries({ queryKey: detailKey(id) });
    },
  });

  return { fit, undo, last, clear: () => setLast(null) };
}
