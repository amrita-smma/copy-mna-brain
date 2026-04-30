import AIFileDump from '@/views/AIFileDump';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function AIFileDumpPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return <AIFileDump showCrm={showCrm} showAiWorkforce={showAiWorkforce} />;
}
