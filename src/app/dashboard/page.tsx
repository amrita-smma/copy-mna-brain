import Dashboard from '@/views/Dashboard';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';

export default async function DashboardPage() {
  const [showCrm, showAiWorkforce] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
  ]);
  return <Dashboard showCrm={showCrm} showAiWorkforce={showAiWorkforce} />;
}
