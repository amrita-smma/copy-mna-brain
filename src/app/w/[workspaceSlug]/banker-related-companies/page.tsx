import BankerRelatedCompanies from '@/views/BankerRelatedCompanies';
import { companyGraphEnabled } from '@/lib/flags';

export default async function BankerRelatedCompaniesPage() {
  // Resolve the shared nav flag so this page's DashboardLayout renders the same
  // sidebar as every other page (avoids the Company Graph item flickering out).
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return <BankerRelatedCompanies showCompanyGraph={showCompanyGraph} />;
}
