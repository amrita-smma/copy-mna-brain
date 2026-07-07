import Chat from '@/views/Chat';
import { companyGraphEnabled } from '@/lib/flags';

export default async function ChatPage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return <Chat showCompanyGraph={showCompanyGraph} />;
}
