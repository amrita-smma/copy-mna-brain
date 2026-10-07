import { notFound } from 'next/navigation';
import SmartFiles from '@/views/SmartFiles';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import {
  type SmartFilesTab,
  firstNonEmptyTab,
  isSmartFilesTab,
} from '@/lib/smartFilesTabs';

type ParsedTab =
  | { kind: 'ok'; initialTab: SmartFilesTab }
  | { kind: 'default' }
  | { kind: 'not-found' };

function parseTab(tab?: string[]): ParsedTab {
  if (!tab || tab.length === 0) {
    return { kind: 'default' };
  }
  if (tab.length === 1 && isSmartFilesTab(tab[0])) {
    return { kind: 'ok', initialTab: tab[0] };
  }
  return { kind: 'not-found' };
}

/**
 * Bare `/smart-files` lands on the first tab that actually has files rather
 * than always opening MoM (which is often empty). The counts double as the
 * view's initial tab badges. Counts are non-critical, so a failure falls back
 * to MoM and lets the view fetch them itself.
 */
async function resolveDefaultTab(): Promise<{
  initialTab: SmartFilesTab;
  initialCounts?: Partial<Record<SmartFilesTab, number>>;
}> {
  try {
    const { fileService } = createContainer(createDb(), await getActiveWorkspaceId());
    const initialCounts = await fileService.countsByType();
    return { initialTab: firstNonEmptyTab(initialCounts) ?? 'mom', initialCounts };
  } catch (error) {
    console.error('Smart Files default tab error:', error);
    return { initialTab: 'mom' };
  }
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

  const { initialTab, initialCounts } =
    parsed.kind === 'ok' ? { initialTab: parsed.initialTab, initialCounts: undefined } : await resolveDefaultTab();

  return (
    <SmartFiles
      initialTab={initialTab}
      initialCounts={initialCounts}
    />
  );
}
