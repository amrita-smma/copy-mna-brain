'use client';

import { useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Zap, FileStack } from 'lucide-react';
import { ChatWindow } from '@/components/chat/ChatWindow';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { cn } from '@/lib/utils';

interface AIDiscoveryProps {
  showCompanyGraph?: boolean;
  showFundManagement?: boolean;
}

export default function AIDiscovery({
  showCompanyGraph = false,
  showFundManagement = false,
}: AIDiscoveryProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Redirect to Smart Files if someone lands here with ?tab=filedump.
  // `filedump` is a legacy inbound link value from when Smart Files was a tab
  // on this page — keep it verbatim so old bookmarks keep resolving.
  useEffect(() => {
    if (searchParams.get('tab') === 'filedump') {
      router.replace('/smart-files', { scroll: false });
    }
  }, [searchParams, router]);

  return (
    <DashboardLayout
      showCompanyGraph={showCompanyGraph}
      showFundManagement={showFundManagement}
    >
      <div className="flex flex-col h-screen p-6">
        {/* Header - AI CoPilot */}
        <div className="relative mb-6 flex-shrink-0">
          <div className="absolute -inset-2 rounded-2xl opacity-20 blur-xl transition-colors duration-500 bg-gradient-to-r from-blue-500 via-blue-500 to-blue-500" />
          <div className="relative flex items-center gap-5">
            <div className="relative group">
              <div className="absolute inset-0 rounded-2xl blur-md opacity-60 group-hover:opacity-80 transition-opacity bg-gradient-to-br from-blue-400 to-blue-600" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl shadow-xl transition-all duration-300 group-hover:scale-105 bg-gradient-to-br from-blue-500 via-blue-500 to-blue-600">
                <Sparkles className="h-7 w-7 text-white drop-shadow-lg" />
                <div
                  className="absolute inset-0 rounded-2xl animate-ping opacity-20 bg-blue-400"
                  style={{ animationDuration: '3s' }}
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
                  AI CoPilot
                </h1>
                <Badge
                  variant="secondary"
                  className="text-xs font-medium px-2 py-0.5 border-0 bg-blue-500/10 text-blue-600 hover:bg-blue-500/20"
                >
                  <Zap className="h-3 w-3 mr-1" />
                  AI Powered
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                Discover targets, analyze companies, and get intelligent insights instantly
              </p>
            </div>
          </div>
        </div>

        {/* AI CoPilot / Smart Files buttons - same styling as sqemnabrain tabs */}
        <div className="inline-flex w-fit mb-4 bg-muted/50 p-1 rounded-lg">
          <Link
            href="/ai-discovery"
            className={cn(
              "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all",
              "bg-blue-500/15 text-blue-600 shadow-sm"
            )}
          >
            <Sparkles className="h-4 w-4" />
            AI CoPilot
          </Link>
          <Link
            href="/smart-files"
            className={cn(
              "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all",
              "text-teal-400/70 hover:bg-teal-500/15 hover:text-teal-600 hover:shadow-sm"
            )}
          >
            <FileStack className="h-4 w-4" />
            Smart Files
          </Link>
        </div>

        {/* Chat */}
        <Card className="flex-1 flex overflow-hidden bg-muted/30 min-h-0 rounded-2xl border shadow-sm">
          <ChatSidebar />
          <div className="flex-1 flex flex-col min-h-0 relative">
            <ChatWindow
              endpoint="/api/chat"
              emoji="🤖"
              placeholder="Ask about companies, analysis, comparisons, or pipeline performance..."
              emptyStateComponent={null}
            />
          </div>
        </Card>
      </div>
    </DashboardLayout>
  );
}
