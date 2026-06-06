'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface GoogleSsoTokenGateProps {
  children: ReactNode;
}

/**
 * Consumes a Google SSO ID token supplied on the dashboard URL
 * (`/dashboard?token=eyJ...`). When present, it exchanges the token for a
 * NextAuth session before rendering its children — this must happen first,
 * otherwise the `ProtectedRoute` inside the dashboard would bounce an
 * not-yet-authenticated visitor to `/login` before the token is processed.
 *
 * The token is stripped from the URL after a successful exchange so it is not
 * left in browser history or re-used on refresh. When no token is present this
 * renders its children immediately and behaves as a no-op.
 */
export function GoogleSsoTokenGate({ children }: GoogleSsoTokenGateProps) {
  const searchParams = useSearchParams();
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
      // Drop the token from the URL, then reveal the dashboard now that the
      // session cookie is set.
      router.replace('/dashboard');
      setExchanging(false);
    })();
  }, [token, signInWithGoogleToken, router]);

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
