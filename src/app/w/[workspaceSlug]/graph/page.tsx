import CompanyGraph from '@/views/CompanyGraph';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

// The graph's filters (including the `?connectedTo=<companyId>` deep link behind
// "Show in relationship graph" on the company detail page) are read client-side
// from the query string by `CompanyGraph` itself — see
// `@/lib/graph/graphFilterParams` — so this page doesn't touch `searchParams`.
export default async function GraphPage() {
  // Resolve whether the current user is a workspace admin — only admins may
  // combine companies. Computed server-side and passed as a boolean prop.
  const session = await auth();
  let isWorkspaceAdmin = false;
  if (session?.user?.id) {
    const workspaceId = await getActiveWorkspaceId();
    const { workspaceService } = createContainer(createDb(), workspaceId);
    isWorkspaceAdmin = await workspaceService.isWorkspaceAdmin(session.user.id, workspaceId);
  }

  return (
    <CompanyGraph
      isWorkspaceAdmin={isWorkspaceAdmin}
    />
  );
}
