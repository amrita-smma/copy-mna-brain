'use client';

import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/hooks/useAuth';
import { ChatProvider } from '@/components/chat/ChatProvider';
import { ThemeProvider } from 'next-themes';
import { FeatureFlagsProvider, FeatureFlags } from '@/hooks/useFeatureFlags';

const queryClient = new QueryClient();

interface ProvidersProps {
  children: ReactNode;
  featureFlags?: FeatureFlags;
}

export function Providers({ children, featureFlags }: ProvidersProps) {
  const flags = featureFlags ?? { aiWorkforceEnabled: false };

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          <FeatureFlagsProvider flags={flags}>
            <ChatProvider>
              <TooltipProvider>
                <Toaster />
                <Sonner />
                {children}
              </TooltipProvider>
            </ChatProvider>
          </FeatureFlagsProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
