import { notFound } from 'next/navigation';
import SmartFiles from '@/views/SmartFiles';
import { type SmartFilesTab, isSmartFilesTab } from '@/lib/smartFilesTabs';

type ParsedTab =
  | { kind: 'ok'; initialTab: SmartFilesTab }
  | { kind: 'not-found' };

function parseTab(tab?: string[]): ParsedTab {
  if (!tab || tab.length === 0) {
    return { kind: 'ok', initialTab: 'mom' };
  }
  if (tab.length === 1 && isSmartFilesTab(tab[0])) {
    return { kind: 'ok', initialTab: tab[0] };
  }
  return { kind: 'not-found' };
}

export default async function SmartFilesPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; tab?: string[] }>;
}) {
  const { tab } = await params;
  const parsed = parseTab(tab);
  if (parsed.kind === 'not-found') {
    notFound();
  }

  return (
    <SmartFiles
      initialTab={parsed.initialTab}
    />
  );
}
