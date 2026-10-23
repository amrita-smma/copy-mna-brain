import { crmBankersViewEnabled } from '@/lib/flags';
import CRM from '@/views/CRM';

export default async function CRMPage() {
  const showBankersView = await crmBankersViewEnabled().then(Boolean);
  return <CRM showBankersView={showBankersView} />;
}
