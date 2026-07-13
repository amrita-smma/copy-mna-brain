import CompanyGraph from '@/views/CompanyGraph';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';

export default async function GraphPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);

  return (
    <CompanyGraph
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    />
  );
}
