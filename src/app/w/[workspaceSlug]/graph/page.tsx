import CompanyGraph from '@/views/CompanyGraph';
import { companyGraphEnabled } from '@/lib/flags';

export default async function GraphPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);

  return <CompanyGraph showCompanyGraph={showCompanyGraph} />;
}
