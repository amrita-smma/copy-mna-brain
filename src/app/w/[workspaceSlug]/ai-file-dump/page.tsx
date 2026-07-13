import AIFileDump from '@/views/AIFileDump';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';

export default async function AIFileDumpPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);
  return (
    <AIFileDump
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    />
  );
}
