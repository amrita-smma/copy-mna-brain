import CRM from '@/views/CRM';
import { crmEnabled, aiWorkforceEnabled, crmGoogleVaultSyncEnabled } from '@/lib/flags';

export default async function CRMPage() {
  const [isCrmEnabled, showAiWorkforce, showVaultSync] = await Promise.all([
    crmEnabled().then(Boolean),
    aiWorkforceEnabled().then(Boolean),
    crmGoogleVaultSyncEnabled().then(Boolean),
  ]);

  if (!isCrmEnabled) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            CRM Feature Not Available
          </h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            This feature is currently disabled. Please contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  return <CRM showCrm={true} showAiWorkforce={showAiWorkforce} showVaultSync={showVaultSync} />;
}
