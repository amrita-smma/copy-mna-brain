import { redirect } from 'next/navigation';
import { crmEnabled, aiWorkforceEnabled } from '@/lib/flags';
import AIWorkforce from '@/views/AIWorkforce';

export default async function AIWorkforcePage() {
  const [showCrm, isEnabled] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled(),
  ]);

  if (!isEnabled) {
    redirect('/dashboard');
  }

  return <AIWorkforce showCrm={showCrm} showAiWorkforce={true} />;
}
