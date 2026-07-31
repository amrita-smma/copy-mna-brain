import { notFound } from 'next/navigation';
import AIFileDump from '@/views/AIFileDump';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';
import { type AiFileDumpTab, isAiFileDumpTab } from '@/lib/aiFileDumpTabs';

type ParsedTab =
  | { kind: 'ok'; initialTab: AiFileDumpTab }
  | { kind: 'not-found' };

function parseTab(tab?: string[]): ParsedTab {
  if (!tab || tab.length === 0) {
    return { kind: 'ok', initialTab: 'mom' };
  }
  if (tab.length === 1 && isAiFileDumpTab(tab[0])) {
    return { kind: 'ok', initialTab: tab[0] };
  }
  return { kind: 'not-found' };
}

export default async function AIFileDumpPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; tab?: string[] }>;
}) {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);

  const { tab } = await params;
  const parsed = parseTab(tab);
  if (parsed.kind === 'not-found') {
    notFound();
  }

  return (
    <AIFileDump
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
      initialTab={parsed.initialTab}
    />
  );
}
