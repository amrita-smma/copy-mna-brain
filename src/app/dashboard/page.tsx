import Dashboard from '@/views/Dashboard';
import { crmEnabled } from '@/lib/flags';

export default async function DashboardPage() {
  const showCrm = Boolean(await crmEnabled());
  return <Dashboard showCrm={showCrm} />;
}
