'use client';

import { ReactNode, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/hooks/useAuth';
import { GoogleSsoTokenGate } from '@/components/auth/GoogleSsoTokenGate';
import { ChatProvider } from '@/components/chat/ChatProvider';
import { PresentationViewerProvider } from '@/components/presentation/PresentationViewerContext';
import { ThemeProvider } from 'next-themes';

const queryClient = new QueryClient();

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          <ChatProvider>
            <PresentationViewerProvider>
              <TooltipProvider>
                <Toaster />
                <Sonner />
                <Suspense fallback={null}>
                  <GoogleSsoTokenGate>{children}</GoogleSsoTokenGate>
                </Suspense>
              </TooltipProvider>
            </PresentationViewerProvider>
          </ChatProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
