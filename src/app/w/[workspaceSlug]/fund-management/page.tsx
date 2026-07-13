import FundManagement from '@/views/FundManagement';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';

export default async function FundManagementPage() {
  const [showCompanyGraph, showFundManagement] = await Promise.all([
    companyGraphEnabled().then(Boolean),
    fundManagementEnabled().then(Boolean),
  ]);

  return (
    <FundManagement
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    />
  );
}
