import CRM from '@/views/CRM';
import {
  companyGraphEnabled,
  fundManagementEnabled,
} from '@/lib/flags';

export default async function CRMPage() {
  const [showCompanyGraph, showFundManagement] = await Promise.all([
    companyGraphEnabled().then(Boolean),
    fundManagementEnabled().then(Boolean),
  ]);

  return (
    <CRM
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    />
  );
}
