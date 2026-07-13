import CompanyGraph from '@/views/CompanyGraph';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

export default async function GraphPage() {
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
    />
  );
}
