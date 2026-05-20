'use client';

import { Suspense, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { LivingBackground } from '@/components/LivingBackground';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiRequest } from '@/lib/api/client';

/**
 * /reset-password renders one of two flows depending on the URL:
 *
 *   /reset-password               → "Forgot your password?" — enter email,
 *                                   we email you a reset link.
 *   /reset-password?token=<tok>   → "Choose a new password" — set a new
 *                                   password using the token from the email.
 *
 * The token is delivered out-of-band via AWS SES (see
 * `src/lib/jobs/handlers/sendEmail.ts`); we never echo it back from the
 * forget-password endpoint.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PageShell><PageLoading /></PageShell>}>
      <ResetPasswordPageInner />
    </Suspense>
  );
}

function ResetPasswordPageInner() {
  const params = useSearchParams();
  const token = params.get('token');
  return token
    ? <PageShell><ResetForm token={token} /></PageShell>
    : <PageShell><RequestForm /></PageShell>;
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center p-4 overflow-hidden">
      <LivingBackground variant="default" />
      <div className="relative z-10 w-full flex justify-center">
        <Card className="w-full max-w-md min-h-[480px] flex flex-col rounded-md border-white/20 bg-white/10 backdrop-blur-xl shadow-lg">
          {children}
        </Card>
      </div>
    </div>
  );
}

function CardLogo() {
  return (
    <CardHeader className="text-center">
      <div className="mx-auto mb-4 flex h-14 items-center justify-center">
        <Image
          src="/logo-light.png"
          alt="Brain 2.0"
          width={120}
          height={56}
          className="h-14 w-auto object-contain rounded-2xl"
          priority
        />
      </div>
      <CardTitle className="text-2xl font-bold tracking-tight text-black dark:text-white">
        Reset Password
      </CardTitle>
    </CardHeader>
  );
}

function PageLoading() {
  return (
    <CardContent className="flex-1 flex items-center justify-center text-black dark:text-white">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </CardContent>
  );
}

function BackToSignInFooter() {
  return (
    <CardFooter className="flex justify-center w-full text-center text-xs font-medium uppercase tracking-[0.15em] text-black/60 dark:text-white/60">
      <Link href="/login" className="hover:underline">
        Back to sign in
      </Link>
    </CardFooter>
  );
}

/* -------------------------------------------------------------- */
/* Step 1 — request a reset link by email                          */
/* -------------------------------------------------------------- */

function RequestForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await apiRequest<{ ok: true }>('/api/auth/forget-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset email');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <CardLogo />
      <CardContent className="flex-1 text-black dark:text-white">
        <CardDescription className="text-xs font-medium uppercase tracking-[0.2em] text-black/70 dark:text-white/70 text-center mb-6">
          Enter your email to receive a reset link
        </CardDescription>

        {submitted ? (
          <Alert className="border-green-500/50 text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>
              If an account exists for that email, we&apos;ve sent a reset link.
              Check your inbox (and spam folder) for instructions.
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-email" className="text-sm text-black/80 dark:text-white/80">
                Email
              </Label>
              <Input
                id="reset-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                className="border-black/20 dark:border-white/20 bg-black/5 dark:bg-white/10 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/50 focus-visible:ring-black/30 dark:focus-visible:ring-white/30"
              />
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
                  Sending link...
                </>
              ) : (
                'Send Reset Link'
              )}
            </Button>
          </form>
        )}
      </CardContent>
      <BackToSignInFooter />
    </>
  );
}

/* -------------------------------------------------------------- */
/* Step 2 — set a new password using the token from the email      */
/* -------------------------------------------------------------- */

function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setIsLoading(true);
    try {
      await apiRequest<{ error: null }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ key: token, password: newPassword }),
      });
      setSuccess(true);
      setTimeout(() => router.push('/login'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <CardLogo />
      <CardContent className="flex-1 text-black dark:text-white">
        <CardDescription className="text-xs font-medium uppercase tracking-[0.2em] text-black/70 dark:text-white/70 text-center mb-6">
          Choose a new password
        </CardDescription>

        {success ? (
          <Alert className="border-green-500/50 text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>
              Password reset successfully. Redirecting to sign in...
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password" className="text-sm text-black/80 dark:text-white/80">
                New Password
              </Label>
              <Input
                id="new-password"
                type="password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                disabled={isLoading}
                className="border-black/20 dark:border-white/20 bg-black/5 dark:bg-white/10 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/50 focus-visible:ring-black/30 dark:focus-visible:ring-white/30"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="text-sm text-black/80 dark:text-white/80">
                Confirm Password
              </Label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={isLoading}
                className="border-black/20 dark:border-white/20 bg-black/5 dark:bg-white/10 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/50 focus-visible:ring-black/30 dark:focus-visible:ring-white/30"
              />
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
                  Resetting...
                </>
              ) : (
                'Reset Password'
              )}
            </Button>
          </form>
        )}
      </CardContent>
      <BackToSignInFooter />
    </>
  );
}
