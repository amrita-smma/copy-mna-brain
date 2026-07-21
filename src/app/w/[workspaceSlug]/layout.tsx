import { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import { CopilotAgentProvider } from '@/components/chat/CopilotAgentContext';
import { FeatureFlagsProvider } from '@/components/layout/FeatureFlagsContext';
import { WorkspaceCurrencyProvider } from '@/components/layout/WorkspaceCurrencyContext';
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
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const { workspaceSlug } = await params;
  const membership = session.user.workspaces.find((w) => w.slug === workspaceSlug);
  const isMember = session.user.isSuperadmin || !!membership;
  if (!isMember) {
    redirect('/workspace');
  }

  const workspaceId = membership?.workspaceId ?? MNA_WORKSPACE_ID;
  const db = createDb();
  const { workspaceService } = createContainer(db, workspaceId);
  const [copilotAgent, defaultCurrency, featureFlags] = await Promise.all([
    workspaceService.getCopilotAgent(workspaceId),
    workspaceService.getDefaultCurrency(workspaceId),
    resolveWorkspaceFeatureFlags(workspaceId),
  ]);

  return (
    <CopilotAgentProvider agentType={copilotAgent}>
      <WorkspaceCurrencyProvider currency={defaultCurrency}>
        <FeatureFlagsProvider flags={featureFlags}>{children}</FeatureFlagsProvider>
      </WorkspaceCurrencyProvider>
    </CopilotAgentProvider>
  );
}
