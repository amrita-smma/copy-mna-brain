import MasterData from '@/views/MasterData';
import { crmEnabled } from '@/lib/flags';

export default async function MasterDataPage() {
  const showCrm = Boolean(await crmEnabled());
  return <MasterData showCrm={showCrm} />;
}
