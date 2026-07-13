import MasterData from '@/views/MasterData';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';

export default async function MasterDataPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);
  return (
    <MasterData
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    />
  );
}
