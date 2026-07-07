'use client';

import { useCallback, useMemo } from 'react';
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
  const { data: session, status, update } = useSession();
  const sessionUser = session?.user;
  // Memoized on the primitive fields, not `session?.user` itself: NextAuth
  // returns a new `session` object on every render, so an unmemoized object
  // literal here would get a fresh reference each render — poisonous for any
  // caller that puts `user` in a useEffect dependency array (an effect that
  // fetches data would re-fire every render, in a loop, forever).
  // `workspaces` is compared by serialized content, not array reference —
  // NextAuth can hand back a fresh array reference for identical content on
  // an incidental session refetch, and this array feeds effect dependency
  // arrays (e.g. `ProtectedRoute`'s membership check) where a reference-only
  // change would retrigger on every render, same failure mode the comment
  // above already guards against for the scalar fields.
  const workspacesKey = JSON.stringify(sessionUser?.workspaces ?? []);
  const user = useMemo(
    () =>
      sessionUser
        ? {
            id: sessionUser.id,
            name: sessionUser.name ?? '',
            email: sessionUser.email ?? '',
            workspaceId: sessionUser.workspaceId ?? null,
            isSuperadmin: sessionUser.isSuperadmin ?? false,
            workspaces: sessionUser.workspaces ?? [],
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionUser?.id, sessionUser?.name, sessionUser?.email, sessionUser?.workspaceId, sessionUser?.isSuperadmin, workspacesKey],
  );

  /**
   * Switch the session's active workspace. The jwt callback in `src/auth.ts`
   * re-validates membership server-side before writing this into the token —
   * a rejected switch silently keeps the previous workspaceId.
   */
  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      await update({ workspaceId });
    },
    [update],
  );

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
    switchWorkspace,
  };
}
