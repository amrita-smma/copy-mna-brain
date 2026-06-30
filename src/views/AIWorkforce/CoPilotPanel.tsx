'use client';

import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { ChatWindow } from '@/components/chat/ChatWindow';
import { ChatSidebar } from '@/components/chat/ChatSidebar';

export function CoPilotPanel() {
  return (
    <div data-testid="copilot-panel" className="flex-1 min-h-0 p-6 bg-card">
      <Card className="h-full flex overflow-hidden bg-muted/30 min-h-0 rounded-2xl border shadow-sm">
        <ChatSidebar />
        <div className="flex-1 flex flex-col min-h-0 relative">
          <ChatWindow
            endpoint="/api/chat"
            emoji="🤖"
            placeholder="Ask about companies, analysis, comparisons, or pipeline performance..."
            emptyStateComponent={
              <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
                <div className="relative mb-5">
                  <div className="absolute inset-0 rounded-2xl blur-md opacity-50 bg-gradient-to-br from-violet-400 to-indigo-500" />
                  <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg">
                    <Sparkles className="h-7 w-7 text-white" />
                  </div>
                </div>
                <h3 className="text-lg font-semibold mb-1">Ask the AI CoPilot</h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  Discover targets, analyze companies, and delegate workforce tasks straight from a
                  conversation.
                </p>
              </div>
            }
          />
        </div>
      </Card>
    </div>
  );
}

export function ComingSoonPanel({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center">
        <p className="text-lg font-medium">{label}</p>
        <p className="text-sm">Coming soon.</p>
      </div>
    </div>
  );
}
