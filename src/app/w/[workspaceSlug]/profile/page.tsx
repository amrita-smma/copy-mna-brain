import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import Profile from '@/views/Profile';
import { copilotMemoryEnabled } from '@/lib/flags';

function ProfileLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

/**
 * The profile page — reached from the mobile bottom nav's Profile tab, and on
 * desktop from the sidebar's account menu. The workspace switcher lives inside
 * it, under the user's name.
 *
 * Flags are resolved here, server-side, and passed down as booleans; the view
 * never resolves a flag itself.
 *
 * Wrapped in `Suspense` like Pipeline and CompanyDetail: the view reads the
 * open tab from `useSearchParams` (`?tab=`), which opts a page out of static
 * rendering unless there is a boundary above it. This page is dynamic anyway —
 * it awaits a flag — so the boundary changes nothing today; it is here so that
 * stops being load-bearing.
 */
export default async function ProfilePage() {
  const showMemoryTab = await copilotMemoryEnabled().then(Boolean);
  return (
    <Suspense fallback={<ProfileLoading />}>
      <Profile showMemoryTab={showMemoryTab} />
    </Suspense>
  );
}
