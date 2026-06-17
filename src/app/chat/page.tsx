import Chat from '@/views/Chat';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function ChatPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return <Chat showCrm={showCrm} showAiWorkforce={showAiWorkforce} />;
}
