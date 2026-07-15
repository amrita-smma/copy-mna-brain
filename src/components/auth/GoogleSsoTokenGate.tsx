'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface GoogleSsoTokenGateProps {
  children: ReactNode;
}

/**
 * Consumes a Google SSO ID token supplied on any URL (`/<route>?token=eyJ...`).
 *
 * This is mounted app-wide (see `Providers`) so the token is honoured on every
 * route — not just the dashboard — and it takes precedence over any existing
 * session: whenever a `token` param is present we exchange it and (re-)establish
 * the session for the email it resolves to, even if the visitor is already
 * signed in as someone else. The exchange must complete before children render,
 * otherwise a `ProtectedRoute` (or the login page's own redirect) could bounce
 * the visitor away before the token is processed.
 *
 * On success the token is stripped from the URL — preserving the current path
 * and any other query params — so it is not left in browser history or re-used
 * on refresh. When no token is present this renders its children immediately and
 * behaves as a no-op.
 */
export function GoogleSsoTokenGate({ children }: GoogleSsoTokenGateProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { signInWithGoogleToken, user, loading } = useAuth();

  const token = searchParams.get('token');
  const [exchanging, setExchanging] = useState(Boolean(token));
  const attempted = useRef(false);

  // Track the latest user/loading without capturing stale closures in the
  // async exchange callback (the session may load while the exchange is in flight).
  const latestUser = useRef(user);
  const latestLoading = useRef(loading);
  useEffect(() => { latestUser.current = user; }, [user]);
  useEffect(() => { latestLoading.current = loading; }, [loading]);

  // Reset the blocking state whenever the URL no longer carries a token so
  // that navigating away after a failed exchange doesn't leave a stuck spinner
  // on the destination page.
  useEffect(() => {
    if (!token) setExchanging(false);
  }, [token]);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    (async () => {
      const { error } = await signInWithGoogleToken(token);
      const params = new URLSearchParams(searchParams.toString());
      params.delete('token');
      const query = params.toString();

      if (error) {
        // If the user already had an authenticated session when the exchange
        // failed (e.g. the link token is expired), keep them on the current
        // page — just strip the stale token. Only redirect to the error page
        // when there is no session to fall back on.
        if (!latestLoading.current && latestUser.current) {
          router.replace(query ? `${pathname}?${query}` : pathname);
        } else {
          router.replace('/login?error=google-sso');
        }
        setExchanging(false);
        return;
      }

      // Drop the token from the URL (keeping the current path and any other
      // query params), then reveal the app now that the session cookie is set.
      router.replace(query ? `${pathname}?${query}` : pathname);
      setExchanging(false);
    })();
  }, [token, signInWithGoogleToken, router, pathname, searchParams]);

  if (exchanging) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground text-sm">Signing you in…</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
