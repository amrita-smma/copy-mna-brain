import { WorkspaceRepository, type DbClient } from '@/lib/repositories';
import { runWithLangfuseWorkspace } from '@/lib/langfuseUser';

/**
 * How long a resolved slug is reused. A slug changes only when an admin renames
 * the workspace, and a trace filed under the old one for a few minutes after is
 * harmless — while a lookup per job or per workforce run is a DB round trip on
 * every background agent run.
 */
const SLUG_TTL_MS = 5 * 60_000;

const slugCache = new Map<string, { slug: string | null; expiresAt: number }>();

/**
 * The slug for `workspaceId`, from a short per-process cache. Never throws:
 * tracing metadata must not fail the work it describes, so a lookup error
 * reads as "no slug" (and is not cached, so the next run tries again).
 */
export async function resolveWorkspaceSlug(
  db: DbClient,
  workspaceId: string | null | undefined,
  now: () => number = Date.now,
): Promise<string | null> {
  if (!workspaceId) return null;
  const cached = slugCache.get(workspaceId);
  if (cached && cached.expiresAt > now()) return cached.slug;
  try {
    const row = await new WorkspaceRepository(db).findById(workspaceId);
    const slug = row?.slug?.trim() || null;
    slugCache.set(workspaceId, { slug, expiresAt: now() + SLUG_TTL_MS });
    return slug;
  } catch (err) {
    console.warn('[langfuse] workspace slug lookup failed', err);
    return null;
  }
}

/**
 * `runWithLangfuseWorkspace` for callers that hold a workspace id rather than a
 * slug — background work (jobs, AI Workforce runs, bot turns, the external
 * chat API) that has no session claims to read the slug from.
 */
export async function runWithLangfuseWorkspaceId<T>(
  db: DbClient,
  workspaceId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const slug = await resolveWorkspaceSlug(db, workspaceId);
  return runWithLangfuseWorkspace(slug, fn);
}

/** Test-only. */
export function resetWorkspaceSlugCacheForTests(): void {
  slugCache.clear();
}
