// /tools — the free tools hub (WP-57; PRODUCT_PLAN.md F-TOOL-01). Public page
// in HybridShell (R-23): the app shell with a session, marketing chrome and
// the site footer (with the legal footer) without one. Where the tools are
// off (GoApply CN-0) the hub lists no tool (the campus calendar link stays
// when that capability is on).

import type { Metadata } from 'next';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { MarketingFooter } from '../../components/features/marketing';
import { ToolsHub } from '../../components/features/tools';
import { freeToolsOpenForRequest, toolsMetadata } from './meta';

export async function generateMetadata(): Promise<Metadata> {
  return toolsMetadata('hub', '/tools');
}

export default async function ToolsPage() {
  const open = await freeToolsOpenForRequest();
  return (
    <HybridShell from="tools" footer={<MarketingFooter />}>
      <ToolsHub toolsOpen={open} />
    </HybridShell>
  );
}
