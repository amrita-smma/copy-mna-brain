import CRM from '@/views/CRM';
import { crmGoogleVaultSyncEnabled, companyGraphEnabled } from '@/lib/flags';

export default async function CRMPage() {
  const [showVaultSync, showCompanyGraph] = await Promise.all([
    crmGoogleVaultSyncEnabled().then(Boolean),
    companyGraphEnabled().then(Boolean),
  ]);

  return <CRM showCompanyGraph={showCompanyGraph} showVaultSync={showVaultSync} />;
}
