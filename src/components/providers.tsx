'use client';

import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/hooks/useAuth';
import { ChatProvider } from '@/components/chat/ChatProvider';
import { PresentationViewerProvider } from '@/components/presentation/PresentationViewerContext';
import { IframeBridge } from '@/components/iframe/IframeBridge';
import PostHogIdentityTracker from '@/components/layout/PostHogIdentityTracker';
import ClientHealthProbe from '@/components/layout/ClientHealthProbe';
import { ThemeProvider } from 'next-themes';

const queryClient = new QueryClient();

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* Launcher↔brain postMessage bridge; no-op unless embedded. Mounted
            inside AuthProvider so it can drive sign-out on a launcher logout. */}
        <IframeBridge />
        {/* Tells PostHog who the user is once the session resolves. Mounted
            here, not on the login page: `before_send` drops everything
            captured on `/login`, which silently swallowed the old identify
            call. */}
        <PostHogIdentityTracker />
        {/* Reports back when an ad blocker is eating our own `/ingest` proxy,
            so blocked users aren't simply invisible. */}
        <ClientHealthProbe />
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          {/* Google-SSO `?token=` deeplinks are consumed server-side in
              `proxy.ts` → `/api/auth/sso` before any page renders, so the
              client never sees a token and there is no in-render sign-in gate
              to race the app's redirects. */}
          <ChatProvider>
            <PresentationViewerProvider>
              <TooltipProvider>
                <Toaster />
                <Sonner />
                {children}
              </TooltipProvider>
            </PresentationViewerProvider>
          </ChatProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
