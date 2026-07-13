import Chat from '@/views/Chat';
import { companyGraphEnabled, fundManagementEnabled } from '@/lib/flags';

export default async function ChatPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  const showFundManagement = await fundManagementEnabled().then(Boolean);
  return (
    <Chat
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    />
  );
}
