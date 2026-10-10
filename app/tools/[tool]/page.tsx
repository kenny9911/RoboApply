// /tools/[tool] — one free tool (WP-57): `resume-check` (F-TOOL-02) and
// `resume-job-match` (F-TOOL-03). Anything else is 404 (there is no
// /tools/cover-letter page; /tools/job-alerts is WP-78's static route). Both
// brands (D5): on GoApply the tool page asks the visitor to tick the
// processing notice before a file is read. A result is never read from the
// URL: the tool page picks up the one this tab asked to keep.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HybridShell } from '../../../components/v3/shell/HybridShell';
import { MarketingFooter } from '../../../components/features/marketing';
import { ToolRunner, toolBySlug } from '../../../components/features/tools';
import { toolsMetadata } from '../meta';

type Props = {
  params: Promise<{ tool: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const entry = toolBySlug((await params).tool);
  if (!entry) return { robots: { index: false, follow: false } };
  return toolsMetadata(entry.key, `/tools/${entry.slug}`);
}

export default async function ToolsToolPage({ params }: Props) {
  const entry = toolBySlug((await params).tool);
  if (!entry) notFound();
  return (
    <HybridShell from="tools" footer={<MarketingFooter />}>
      <ToolRunner kind={entry.kind} />
    </HybridShell>
  );
}
