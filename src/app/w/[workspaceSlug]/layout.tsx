import { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getSession } from '@/lib/server/session';
import { loginUrlWithCallback, consentUrlWithCallback } from '@/lib/callbackUrl';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { normalizeCopilotAgent } from '@/lib/services/workspaceService';
import { normalizeCurrency } from '@/lib/currency';
import { resolvePipelineHeading } from '@/lib/pipeline/heading';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import { CopilotAgentProvider } from '@/components/chat/CopilotAgentContext';
import { AppShell } from '@/components/layout/AppShell';
import { FeatureFlagsProvider } from '@/components/layout/FeatureFlagsContext';
import { WorkspaceCurrencyProvider } from '@/components/layout/WorkspaceCurrencyContext';
import { PipelineHeadingProvider } from '@/components/layout/PipelineHeadingContext';
import PostHogWorkspaceTracker from '@/components/layout/PostHogWorkspaceTracker';
import { TableLayoutProvider } from '@/components/table';
import { resolveWorkspaceFeatureFlags } from '@/lib/features/overrides';

/**
 * Membership gate for every `/w/[workspaceSlug]/...` route. `proxy.ts`
 * already redirects unauthenticated/non-member requests before this ever
 * renders — this is defense-in-depth, not the only check.
 *
 * Deliberately does NOT call `switchWorkspace`/session `update()`. Visiting a
 * `/w/<slug>/` URL must never rewrite the shared session cookie to match —
 * that would put two tabs on two different workspaces right back to fighting
 * over one cookie, undoing the whole point of URL-scoped workspaces. This
 * layout only reads and gates; it never writes session state.
 */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceSlug: string }>;
}) {
  const session = await getSession();
  const { workspaceSlug } = await params;
  if (!session?.user) {
    // Preserve the deeplink, same as the `proxy.ts` gate that normally catches
    // this first. `X-Pathname` is injected by that proxy branch; falling back
    // to the workspace root keeps at least the workspace when it's absent.
    const requestPath = (await headers()).get('X-Pathname');
    redirect(loginUrlWithCallback(requestPath ?? `/w/${workspaceSlug}`));
  }

  if (!session.user.hasConsented) {
    const requestPath = (await headers()).get('X-Pathname');
    redirect(consentUrlWithCallback(requestPath ?? `/w/${workspaceSlug}`));
  }

  const membership = session.user.workspaces.find((w) => w.slug === workspaceSlug);
  const isMember = session.user.isSuperadmin || !!membership;
  if (!isMember) {
    redirect('/workspace');
  }

  const db = createDb();
  const { workspaceService } = createContainer(db, membership?.workspaceId ?? MNA_WORKSPACE_ID);

  // Soft-delete gate. An archived workspace already drops out of every
  // membership list (so `proxy.ts` bounces ordinary members on the JWT claim
  // alone), but two callers still reach this point: a superadmin, whom the
  // proxy waves through every slug by design, and anyone holding a JWT issued
  // before the workspace was archived. This is the only gate with DB access,
  // so it's the one that has to fail closed — for everyone, superadmin
  // included. A soft-deleted workspace is inaccessible, not merely hidden.
  const workspace = await workspaceService.findActiveWorkspaceBySlug(workspaceSlug);
  if (!workspace) {
    redirect('/workspace');
  }

  const workspaceId = workspace.id;
  // `copilot_agent` and `default_currency` are columns on the row we just
  // fetched, so normalize them in place. Calling `getCopilotAgent` /
  // `getDefaultCurrency` here would re-SELECT this same workspace row twice
  // more — three identical reads on the critical path of every page load.
  const copilotAgent = normalizeCopilotAgent(workspace.copilot_agent);
  const defaultCurrency = normalizeCurrency(workspace.default_currency);
  const pipelineHeading = resolvePipelineHeading(
    workspace.pipeline_title,
    workspace.pipeline_subtitle,
  );
  const featureFlags = await resolveWorkspaceFeatureFlags(workspaceId);

  return (
    <CopilotAgentProvider agentType={copilotAgent}>
      <WorkspaceCurrencyProvider currency={defaultCurrency}>
        {/* Keyed by slug for the same reason as TableLayoutProvider below: the
            provider seeds its state from this prop once, so a soft navigation
            to another workspace must remount it rather than keep showing the
            previous workspace's heading. */}
        <PipelineHeadingProvider key={workspaceSlug} heading={pipelineHeading}>
          <FeatureFlagsProvider flags={featureFlags}>
            {/* Table column layouts are workspace settings, shared by every
                member — loaded once here rather than per table. Keyed by slug so
                a soft navigation to another workspace remounts the provider and
                refetches, instead of reusing (and then saving) the previous
                workspace's layouts. */}
            <TableLayoutProvider key={workspaceSlug}>
              <PostHogWorkspaceTracker workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
              {/* The app shell lives HERE, not inside each view. Because it sits
                  above the routed `children`, moving between console tabs is a
                  soft navigation that swaps only the page — the sidebar, the
                  copilot pane, and any in-flight chat stream stay mounted. */}
              {/* `initialUser` is the session this layout already gated on, handed
                  to the client gate so it doesn't re-block on `useSession` and
                  flash a spinner over a page the server has already authorized. */}
              <AppShell
                initialUser={{
                  isSuperadmin: session.user.isSuperadmin ?? false,
                  workspaces: session.user.workspaces ?? [],
                }}
              >
                {children}
              </AppShell>
            </TableLayoutProvider>
          </FeatureFlagsProvider>
        </PipelineHeadingProvider>
      </WorkspaceCurrencyProvider>
    </CopilotAgentProvider>
  );
}
