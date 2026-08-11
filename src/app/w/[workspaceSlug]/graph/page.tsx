import CompanyGraph from '@/views/CompanyGraph';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `?connectedTo=<companyId>` opens the graph already filtered to that company
  // and its direct connections — the deep link behind "Show in relationship
  // graph" on the company detail page.
  const connectedTo = (await searchParams).connectedTo;
  const initialConnectedCompanyId = typeof connectedTo === 'string' ? connectedTo : undefined;

  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);

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
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
      isWorkspaceAdmin={isWorkspaceAdmin}
      initialConnectedCompanyId={initialConnectedCompanyId}
    />
  );
}
