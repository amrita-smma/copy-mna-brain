import CRM from '@/views/CRM';
import {
  crmGoogleVaultSyncEnabled,
  companyGraphEnabled,
  fundManagementEnabled,
} from '@/lib/flags';

export default async function CRMPage() {
  const [showVaultSync, showCompanyGraph, showFundManagement] = await Promise.all([
    crmGoogleVaultSyncEnabled().then(Boolean),
    companyGraphEnabled().then(Boolean),
    fundManagementEnabled().then(Boolean),
  ]);

  return (
    <CRM
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
      showVaultSync={showVaultSync}
    />
  );
}
