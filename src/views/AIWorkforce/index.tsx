'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Sparkles, Users } from 'lucide-react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { useChatContext } from '@/components/chat/ChatProvider';
import { cn } from '@/lib/utils';

import { CoPilotPanel, ComingSoonPanel } from './CoPilotPanel';
import { WorkforceTasks } from './WorkforceTasks';

type TabKey = 'copilot' | 'workforce' | 'ingestion';

interface AIWorkforceProps {
  showCompanyGraph?: boolean;
  initialTab?: TabKey;
  initialChatId?: string | null;
  initialTaskId?: string | null;
}

const tabs: { key: TabKey; label: string; icon: typeof Sparkles; dot?: boolean }[] = [
  { key: 'copilot', label: 'AI CoPilot', icon: Sparkles },
  { key: 'workforce', label: 'Workforce Tasks', icon: Users, dot: true },
  { key: 'ingestion', label: 'File Ingestion', icon: FileText },
];

export default function AIWorkforce({
  showCompanyGraph = false,
  initialTab = 'workforce',
  initialChatId = null,
  initialTaskId = null,
}: AIWorkforceProps) {
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const router = useRouter();
  const { chatId, setChatId } = useChatContext();

  // Seed chatId from the URL on mount, then keep URL in sync with subsequent
  // state changes — but only for the copilot tab. The workforce tab manages
  // its own URL inside WorkforceTasks since the selection state lives there.
  // Combined into one effect (gated by `reconciled`) so URL sync never fires
  // before the initial seeding completes — otherwise the first render writes
  // "/ai-workforce/ai-copilot" before chatId arrives, stripping the chatId
  // from the URL on every refresh.
  const reconciled = useRef(false);
  useEffect(() => {
    if (!reconciled.current) {
      if (initialChatId !== null && chatId !== initialChatId) {
        setChatId(initialChatId);
        return;
      }
      reconciled.current = true;
    }
    // Workforce tab owns its URL — see WorkforceTasks.
    if (activeTab !== 'copilot') return;
    const target = chatId
      ? `/ai-workforce/ai-copilot/${chatId}`
      : '/ai-workforce/ai-copilot';
    if (typeof window !== 'undefined' && window.location.pathname !== target) {
      router.replace(target);
    }
  }, [initialChatId, activeTab, chatId, setChatId, router]);

  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex-shrink-0 px-8 pt-8 pb-4 bg-card">
          <div className="flex items-start gap-4">
            <div className="relative">
              <div className="absolute inset-0 rounded-2xl blur-md opacity-50 bg-gradient-to-br from-violet-400 to-indigo-500" />
              <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg">
                <Sparkles className="h-6 w-6 text-white" />
              </div>
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">AI Workspace</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Discover targets, analyze companies, delegate tasks
              </p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex-shrink-0 px-8 border-b bg-card">
          <div className="flex items-center gap-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    'relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors',
                    active
                      ? 'text-violet-600'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                  {tab.dot && (
                    <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                  )}
                  {active && (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 bg-violet-600 rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        {activeTab === 'workforce' && <WorkforceTasks initialTaskId={initialTaskId} />}
        {activeTab === 'copilot' && <CoPilotPanel />}
        {activeTab === 'ingestion' && <ComingSoonPanel label="File Ingestion" />}
      </div>
    </DashboardLayout>
  );
}
