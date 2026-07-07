import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/auth';

/**
 * Best-effort bridge for pre-migration flat URLs (bookmarks, already-sent
 * email deeplinks) that 404 now that these routes live under
 * `/w/[workspaceSlug]/...`. Resolves the visiting user's *session* workspace
 * slug and redirects there — this is convenience only, not a tenant-security
 * claim, since the target comes from the session, not the URL itself.
 *
 * `searchParams` (e.g. `?stage=L0` on an old `/pipeline` link) is carried
 * through to the new URL so filter/query state in a bookmarked link isn't lost.
 */
export async function redirectToWorkspaceScoped(
  path: string,
  searchParams?: Record<string, string | string[] | undefined>,
): Promise<never> {
  // An internal link should never land here — only external bookmarks/emails
  // should. Landing here from a `/w/<slug>/...` referer means some internal
  // navigation still hardcodes a flat path and got silently routed through
  // this session-cookie-based bridge instead of the tab's own URL slug —
  // exactly the per-tab race this whole plan exists to avoid. Loud in dev
  // only; this never blocks the redirect itself.
  if (process.env.NODE_ENV !== 'production') {
    const referer = (await headers()).get('referer') ?? '';
    if (referer.includes('/w/')) {
      // eslint-disable-next-line no-console
      console.warn(
        `[legacyWorkspaceRedirect] internal navigation hit a legacy stub (${path}) from ${referer} — some call site still hardcodes a flat path instead of useWorkspaceHref/<WorkspaceLink>.`,
      );
    }
  }

  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }
  const match = session.user.workspaces.find((w) => w.workspaceId === session.user.workspaceId);
  if (!match) {
    redirect('/workspace');
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) {
      value.forEach((v) => query.append(key, v));
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  const qs = query.toString();
  redirect(`/w/${match.slug}${path}${qs ? `?${qs}` : ''}`);
}
