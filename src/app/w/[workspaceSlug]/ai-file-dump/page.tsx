import AIFileDump from '@/views/AIFileDump';
import { companyGraphEnabled } from '@/lib/flags';

export default async function AIFileDumpPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return <AIFileDump showCompanyGraph={showCompanyGraph} />;
}
