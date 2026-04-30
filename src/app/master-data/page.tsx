import MasterData from '@/views/MasterData';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function MasterDataPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return <MasterData showCrm={showCrm} showAiWorkforce={showAiWorkforce} />;
}
