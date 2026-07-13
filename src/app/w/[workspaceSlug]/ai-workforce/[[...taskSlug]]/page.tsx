import { notFound } from 'next/navigation';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';
import AIWorkforce from '@/views/AIWorkforce';

type TabKey = 'copilot' | 'workforce' | 'ingestion';

type ParsedSlug =
  | {
      kind: 'ok';
      initialTab: TabKey;
      initialChatId: string | null;
      initialTaskId: string | null;
    }
  | { kind: 'not-found' };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseSlug(taskSlug?: string[]): ParsedSlug {
  if (!taskSlug || taskSlug.length === 0) {
    return {
      kind: 'ok',
      initialTab: 'workforce',
      initialChatId: null,
      initialTaskId: null,
    };
  }
  if (taskSlug[0] === 'ai-copilot' && taskSlug.length <= 2) {
    return {
      kind: 'ok',
      initialTab: 'copilot',
      initialChatId: taskSlug[1] ?? null,
      initialTaskId: null,
    };
  }
  // /ai-workforce/tasks/<uuid> — workforce tab with a specific row preselected.
  // Validate the UUID so a junk path 404s instead of silently selecting nothing.
  if (taskSlug[0] === 'tasks' && taskSlug.length === 2 && UUID_RE.test(taskSlug[1])) {
    return {
      kind: 'ok',
      initialTab: 'workforce',
      initialChatId: null,
      initialTaskId: taskSlug[1],
    };
  }
  // Unknown slug (e.g. analytics scripts using path-relative URLs). 404 so
  // we don't accidentally serve HTML to a script tag expecting JS.
  return { kind: 'not-found' };
}

export default async function AIWorkforcePage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; taskSlug?: string[] }>;
}) {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);

  const { taskSlug } = await params;
  const parsed = parseSlug(taskSlug);
  if (parsed.kind === 'not-found') {
    notFound();
  }

  return (
    <AIWorkforce
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
      initialTab={parsed.initialTab}
      initialChatId={parsed.initialChatId}
      initialTaskId={parsed.initialTaskId}
    />
  );
}
