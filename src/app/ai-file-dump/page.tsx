import AIFileDump from '@/views/AIFileDump';
import { crmEnabled } from '@/lib/flags';

export default async function AIFileDumpPage() {
  const showCrm = Boolean(await crmEnabled());
  return <AIFileDump showCrm={showCrm} />;
}
