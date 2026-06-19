import MasterData from '@/views/MasterData';
import { companyGraphEnabled } from '@/lib/flags';

export default async function MasterDataPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return <MasterData showCompanyGraph={showCompanyGraph} />;
}
