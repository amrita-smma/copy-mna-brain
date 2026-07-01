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
  const { signInWithGoogleToken } = useAuth();

  const token = searchParams.get('token');
  const [exchanging, setExchanging] = useState(Boolean(token));
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    (async () => {
      const { error } = await signInWithGoogleToken(token);
      if (error) {
        router.replace('/login?error=google-sso');
        return;
      }
      // Drop the token from the URL (keeping the current path and any other
      // query params), then reveal the app now that the session cookie is set.
      const params = new URLSearchParams(searchParams.toString());
      params.delete('token');
      const query = params.toString();
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
