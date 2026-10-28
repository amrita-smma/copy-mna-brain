import { notFound, redirect } from 'next/navigation';
import AIWorkforce from '@/views/AIWorkforce';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { redirectUnlessRecordExists } from '@/lib/recordRedirect';

type ParsedSlug =
  | { kind: 'ok'; initialTaskId: string | null }
  | { kind: 'redirect-to-root' }
  | { kind: 'not-found' };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseSlug(taskSlug?: string[]): ParsedSlug {
  if (!taskSlug || taskSlug.length === 0) {
    return { kind: 'ok', initialTaskId: null };
  }
  // The in-page AI CoPilot tab is gone — the copilot lives in the shell's pane
  // now. Bounce its old deeplinks to the queue instead of 404ing them; the
  // trailing chat id has nowhere to go (chat selection is client state, not a
  // route), so it is dropped rather than silently ignored.
  if (taskSlug[0] === 'ai-copilot' && taskSlug.length <= 2) {
    return { kind: 'redirect-to-root' };
  }
  // /ai-workforce/tasks/<uuid> — a specific row preselected. Validate the UUID
  // so a junk path 404s instead of silently selecting nothing.
  if (taskSlug[0] === 'tasks' && taskSlug.length === 2 && UUID_RE.test(taskSlug[1])) {
    return { kind: 'ok', initialTaskId: taskSlug[1] };
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
  const { workspaceSlug, taskSlug } = await params;
  const parsed = parseSlug(taskSlug);
  if (parsed.kind === 'not-found') {
    notFound();
  }
  if (parsed.kind === 'redirect-to-root') {
    redirect(`/w/${workspaceSlug}/ai-workforce`);
  }
  // A run from another workspace (e.g. after a workspace switch) falls back to
  // the queue rather than preselecting a row that isn't there.
  const { initialTaskId } = parsed;
  if (initialTaskId) {
    const { aiWorkforceService } = createContainer(createDb(), await getActiveWorkspaceId());
    await redirectUnlessRecordExists(
      initialTaskId,
      (id) => aiWorkforceService.taskExists(id),
      `/w/${workspaceSlug}/ai-workforce`,
    );
  }

  return <AIWorkforce initialTaskId={initialTaskId} />;
}
