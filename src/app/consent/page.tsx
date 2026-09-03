import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { CALLBACK_URL_PARAM, loginUrlWithCallback, sanitizeCallbackUrl } from '@/lib/callbackUrl';
import { ConsentForm } from '@/components/consent/ConsentForm';

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  const params = await searchParams;
  const rawCallback = params[CALLBACK_URL_PARAM];
  const callback = typeof rawCallback === 'string' ? rawCallback : undefined;

  if (!session?.user) {
    const consentPath = callback
      ? `/consent?${CALLBACK_URL_PARAM}=${encodeURIComponent(callback)}`
      : '/consent';
    redirect(loginUrlWithCallback(consentPath));
  }

  const destination = sanitizeCallbackUrl(callback) ?? '/workspace';

  // Already consented (e.g. a stale bookmark, or a race with a session
  // refresh elsewhere) — nothing to show, just forward on.
  if (session.user.hasConsented) {
    redirect(destination);
  }

  return <ConsentForm destination={destination} />;
}
