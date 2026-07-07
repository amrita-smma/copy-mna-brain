'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { LivingBackground } from '@/components/LivingBackground';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle } from 'lucide-react';
import posthog from 'posthog-js';
import { apiRequest } from '@/lib/api/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { signIn, signInWithGoogleToken, user, loading } = useAuth();
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const logoSrc = '/logo-light.png';

  useEffect(() => {
    if (!loading && user) {
      router.replace('/workspace');
    }
  }, [user, loading, router]);

  const completeSignIn = (signedInEmail: string, method: 'password' | 'google') => {
    const normalizedEmail = signedInEmail.toLowerCase().trim();
    posthog.identify(normalizedEmail, {
      email: normalizedEmail,
    });
    posthog.capture('user_signed_in', {
      email: normalizedEmail,
      method,
    });
    router.push('/workspace');
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const { error } = await signIn(email, password);

    if (error) {
      setError(error.message);
      setIsLoading(false);
    } else {
      completeSignIn(email, 'password');
    }
  };

  const handleGoogleCredential = async (token: string) => {
    setError(null);
    setIsLoading(true);

    // Pre-flight: verify the Google token and confirm the email maps to a
    // registered user, so we can show the precise "not registered" message
    // (the NextAuth provider only returns an opaque failure code).
    let signedInEmail = '';
    try {
      const data = await apiRequest<{ email?: string }>('/api/auth/google-signin', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      signedInEmail = data?.email ?? '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
      setIsLoading(false);
      return;
    }

    // The pre-flight passed — establish the session through NextAuth.
    const { error } = await signInWithGoogleToken(token);
    if (error) {
      setError(error.message);
      setIsLoading(false);
      return;
    }

    completeSignIn(signedInEmail, 'google');
  };



  if (loading) {
    return (
      <div className="relative flex min-h-screen items-center justify-center">
        <LivingBackground variant="default" />
        <div className="relative z-10">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (user) {
    return null;
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4 overflow-hidden">
      <LivingBackground variant="default" />
      <div className="relative z-10 w-full flex justify-center">
      <Card className="w-full max-w-md min-h-[480px] flex flex-col rounded-md border-white/20 bg-white/10 backdrop-blur-xl shadow-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-14 items-center justify-center">
            <Image
              src={logoSrc}
              alt="Brain 2.0"
              width={120}
              height={56}
              className="h-14 w-auto object-contain rounded-2xl"
              priority
            />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight text-black dark:text-white">BRAIN 2.0</CardTitle>
          <CardDescription className="text-xs font-medium uppercase tracking-[0.2em] text-black/70 dark:text-white/70">
            ENTERPRISE DEAL INTELLIGENCE
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1 text-black dark:text-white">
          <form onSubmit={handleSignIn} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signin-email" className="text-sm text-black/80 dark:text-white/80">Email</Label>
              <Input
                id="signin-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                className="border-black/20 dark:border-white/20 bg-black/5 dark:bg-white/10 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/50 focus-visible:ring-black/30 dark:focus-visible:ring-white/30"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signin-password" className="text-sm text-black/80 dark:text-white/80">Password</Label>
              <Input
                id="signin-password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                className="border-black/20 dark:border-white/20 bg-black/5 dark:bg-white/10 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/50 focus-visible:ring-black/30 dark:focus-visible:ring-white/30"
              />
              <div className="text-right">
                <Link
                  href="/reset-password"
                  className="text-xs text-black/70 hover:text-black dark:text-white/70 dark:hover:text-white hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign In'
              )}
            </Button>
          </form>

          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
            <span className="text-xs font-medium uppercase tracking-[0.15em] text-black/50 dark:text-white/50">
              Or
            </span>
            <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
          </div>

          <GoogleSignInButton onCredential={handleGoogleCredential} disabled={isLoading} />
        </CardContent>
        <CardFooter className="flex justify-center w-full text-center text-xs font-medium uppercase tracking-[0.15em] text-black/60 dark:text-white/60">
          SECURED BY NEURAL CORE LOGIC
        </CardFooter>
      </Card>
      </div>
    </div>
  );
}
