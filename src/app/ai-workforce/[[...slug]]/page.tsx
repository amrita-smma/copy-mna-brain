import { notFound, redirect } from 'next/navigation';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';
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

function parseSlug(slug?: string[]): ParsedSlug {
  if (!slug || slug.length === 0) {
    return {
      kind: 'ok',
      initialTab: 'workforce',
      initialChatId: null,
      initialTaskId: null,
    };
  }
  if (slug[0] === 'ai-copilot' && slug.length <= 2) {
    return {
      kind: 'ok',
      initialTab: 'copilot',
      initialChatId: slug[1] ?? null,
      initialTaskId: null,
    };
  }
  // /ai-workforce/tasks/<uuid> — workforce tab with a specific row preselected.
  // Validate the UUID so a junk path 404s instead of silently selecting nothing.
  if (slug[0] === 'tasks' && slug.length === 2 && UUID_RE.test(slug[1])) {
    return {
      kind: 'ok',
      initialTab: 'workforce',
      initialChatId: null,
      initialTaskId: slug[1],
    };
  }
  // Unknown slug (e.g. analytics scripts using path-relative URLs). 404 so
  // we don't accidentally serve HTML to a script tag expecting JS.
  return { kind: 'not-found' };
}

export default async function AIWorkforcePage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const [showCrm, isEnabled] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled(),
  ]);

  if (!isEnabled) {
    redirect('/dashboard');
  }

  const { slug } = await params;
  const parsed = parseSlug(slug);
  if (parsed.kind === 'not-found') {
    notFound();
  }

  return (
    <AIWorkforce
      showCrm={showCrm}
      showAiWorkforce={true}
      initialTab={parsed.initialTab}
      initialChatId={parsed.initialChatId}
      initialTaskId={parsed.initialTaskId}
    />
  );
}
