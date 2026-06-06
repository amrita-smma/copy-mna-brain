'use client';

import { useCallback } from 'react';
import {
  SessionProvider,
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
  useSession,
} from 'next-auth/react';
import posthog from 'posthog-js';

export { SessionProvider as AuthProvider };

interface SignInResult {
  error: Error | null;
}

export function useAuth() {
  const { data: session, status } = useSession();
  const user = session?.user
    ? {
        id: session.user.id,
        name: session.user.name ?? '',
        email: session.user.email ?? '',
      }
    : null;

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    const result = await nextAuthSignIn('credentials', {
      email,
      password,
      redirect: false,
    });
    if (!result || result.error) {
      return { error: new Error(result?.error ?? 'Invalid email or password') };
    }
    return { error: null };
  }, []);

  const signInWithGoogleToken = useCallback(
    async (token: string): Promise<SignInResult> => {
      const result = await nextAuthSignIn('google-sso', {
        token,
        redirect: false,
      });
      if (!result || result.error) {
        return { error: new Error(result?.error ?? 'Google sign-in failed') };
      }
      return { error: null };
    },
    [],
  );

  const signOut = useCallback(async () => {
    posthog.capture('user_signed_out');
    posthog.reset();
    await nextAuthSignOut({ redirect: false });
  }, []);

  return {
    user,
    loading: status === 'loading',
    signIn,
    signInWithGoogleToken,
    signOut,
  };
}
