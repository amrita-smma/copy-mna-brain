'use client';

import { useState } from 'react';
import DashboardLayout from '@/components/layout/DashboardLayout';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { ChatWindow } from '@/components/chat/ChatWindow';
import {
  Sparkles,
  Users,
  FileText,
  Plus,
  CircleDot,
  CheckCircle2,
  ChevronDown,
  Presentation,
  LayoutGrid,
  MessagesSquare,
  Search,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface AIWorkforceProps {
  showCrm?: boolean;
  showAiWorkforce?: boolean;
}

type TabKey = 'copilot' | 'workforce' | 'ingestion';

const tabs: { key: TabKey; label: string; icon: typeof Sparkles; dot?: boolean }[] = [
  { key: 'copilot', label: 'AI CoPilot', icon: Sparkles },
  { key: 'workforce', label: 'Workforce Tasks', icon: Users, dot: true },
  { key: 'ingestion', label: 'File Ingestion', icon: FileText },
];

const queuedTasks = [
  { idx: 1, title: 'Deck — TechSlurry GmbH', owner: 'Maria', initials: 'MR', icon: Presentation },
  { idx: 2, title: 'Wet processing comps', owner: 'David', initials: 'DK', icon: LayoutGrid },
  { idx: 3, title: 'Refresh Project Oriole', owner: 'You', initials: 'AA', icon: MessagesSquare },
  { idx: 4, title: 'Korean TIM search', owner: 'James', initials: 'JT', icon: Search },
];

const doneTasks = [
  { title: 'Outbound — APAC slurries', owner: 'Sarah', initials: 'SC', meta: '2h' },
  { title: 'Deck — Beta Polymers', owner: 'David', initials: 'DK', meta: '4h' },
];

export default function AIWorkforce({ showCrm = false, showAiWorkforce = false }: AIWorkforceProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('workforce');

  return (
    <DashboardLayout showCrm={showCrm} showAiWorkforce={showAiWorkforce}>
      <div className="flex flex-col h-full animate-fade-in">
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
                    <span className="ml-1 h-1.5 w-1.5 rounded-full bg-violet-500" />
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
        {activeTab === 'workforce' && <WorkforceTasks />}
        {activeTab === 'copilot' && <CoPilotPanel />}
        {activeTab === 'ingestion' && <ComingSoonPanel label="File Ingestion" />}
      </div>
    </DashboardLayout>
  );
}

function WorkforceTasks() {
  return (
    <div className="flex-1 grid grid-cols-[320px_1fr] min-h-0 overflow-hidden">
      {/* Left: routine list */}
      <aside className="border-r overflow-y-auto p-4 space-y-6 bg-card">
        <Button
          variant="outline"
          className="w-full justify-center h-10 border-dashed text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Routine
        </Button>

        {/* In progress */}
        <div className="space-y-2">
          <SectionHeader label="In progress" count={1} />
          <button className="relative w-full text-left rounded-lg border bg-violet-50/40 ring-1 ring-violet-200/60 p-3 pl-4 hover:bg-violet-50/70 transition-colors">
            <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-violet-500" />
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-100 text-amber-600 flex-shrink-0">
                <Clock className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  Project Maple — L0/L1 screeni…
                </p>
                <div className="flex items-center gap-1.5 mt-1">
                  <Avatar className="h-4 w-4">
                    <AvatarFallback className="text-[8px] bg-violet-100 text-violet-700">
                      SC
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-xs text-muted-foreground">Sarah · 8m</span>
                </div>
              </div>
            </div>
          </button>
        </div>

        {/* Queued */}
        <div className="space-y-2">
          <SectionHeader label="Queued" count={4} hint="drag to reorder" />
          <ul className="space-y-1">
            {queuedTasks.map((task) => {
              const Icon = task.icon;
              return (
                <li
                  key={task.idx}
                  className="flex items-start gap-3 rounded-lg p-2.5 hover:bg-muted/60 cursor-pointer transition-colors"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground flex-shrink-0">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      <span className="text-muted-foreground mr-1">#{task.idx}</span>
                      {task.title}
                    </p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Avatar className="h-4 w-4">
                        <AvatarFallback className="text-[8px] bg-muted text-muted-foreground">
                          {task.initials}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs text-muted-foreground">{task.owner}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Done today */}
        <div className="space-y-2">
          <SectionHeader label="Done today" count={7} />
          <ul className="space-y-1">
            {doneTasks.map((task) => (
              <li
                key={task.title}
                className="flex items-start gap-3 rounded-lg p-2.5 hover:bg-muted/60 cursor-pointer transition-colors"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-50 text-emerald-600 flex-shrink-0">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{task.title}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Avatar className="h-4 w-4">
                      <AvatarFallback className="text-[8px] bg-muted text-muted-foreground">
                        {task.initials}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-xs text-muted-foreground">
                      {task.owner} · {task.meta}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Right: task detail */}
      <section className="overflow-y-auto p-8 space-y-8 bg-card">
        {/* Status pill */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
            <span className="flex items-center gap-1.5 text-amber-600">
              <CircleDot className="h-3 w-3 fill-amber-500 text-amber-500" />
              In progress
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span>L0/L1 screening</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight">
            Screening 5 inbound targets — Project Maple
          </h2>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Avatar className="h-5 w-5">
              <AvatarFallback className="text-[10px] bg-violet-100 text-violet-700">
                SC
              </AvatarFallback>
            </Avatar>
            <span>Sarah Chen</span>
            <span className="text-muted-foreground/50">·</span>
            <span>Started 8 min ago</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="flex items-center gap-1 text-violet-600">
              <Sparkles className="h-3.5 w-3.5" />
              Spawned from CoPilot
            </span>
          </div>
        </div>

        {/* Instructions */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
            Instructions
          </h3>
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Avatar className="h-5 w-5">
                  <AvatarFallback className="text-[10px] bg-violet-100 text-violet-700">
                    SC
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">Sarah Chen</span>
              </div>
              <span className="text-xs text-muted-foreground">14:24</span>
            </div>
            <p className="text-sm text-foreground/90 leading-relaxed">
              Screen the 5 inbound targets in the Project Maple folder. Standard L0 + L1
              criteria. Flag any borderline ones for me.
            </p>
          </div>
        </div>

        {/* Reasoning trace */}
        <div className="space-y-4">
          <h3 className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
            Reasoning trace
          </h3>

          <TraceStep
            title="Ingested 3 source documents"
            description="Banker teaser, supplemental memo, supplier list. Extracted 5 candidate companies."
            timestamp="14:32:08"
            tool="file_dump.read"
            args="teaser.pdf, memo.docx, suppliers.xlsx"
            meta="3 files · 124 pages"
          >
            <div className="space-y-2 pt-1">
              <p className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                Output
              </p>
              <div className="space-y-1.5 text-sm font-mono">
                <p>
                  <span className="text-violet-600">teaser.pdf</span>
                  <span className="text-muted-foreground"> · 12 pages, extracted 5 candidate companies</span>
                </p>
                <p>
                  <span className="text-violet-600">memo.docx</span>
                  <span className="text-muted-foreground"> · 8 pages, sector context + risk factors</span>
                </p>
              </div>
            </div>
          </TraceStep>

          <TraceStep
            title="Resolved company identities"
            description="5/5 matched in CapIQ. Flagged 1 entity with parent-co ambiguity."
            timestamp="14:32:24"
            tool="capiq.search"
            args="company_name × 5"
            meta="5 matches"
          >
            <div className="space-y-2 pt-1">
              <p className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                Matched entities
              </p>
            </div>
          </TraceStep>
        </div>
      </section>
    </div>
  );
}

function SectionHeader({
  label,
  count,
  hint,
}: {
  label: string;
  count: number;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between px-1">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-muted-foreground">
        <span>{label}</span>
        <span className="text-muted-foreground/60">· {count}</span>
      </div>
      {hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

function TraceStep({
  title,
  description,
  timestamp,
  tool,
  args,
  meta,
  children,
}: {
  title: string;
  description: string;
  timestamp: string;
  tool: string;
  args: string;
  meta: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center pt-0.5">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
        </div>
      </div>
      <div className="flex-1 space-y-3 pb-2">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          <p className="text-xs text-muted-foreground/70 mt-1 font-mono">{timestamp}</p>
        </div>

        <div className="rounded-lg border bg-violet-50/30 ring-1 ring-violet-100">
          <div className="flex items-center justify-between px-3 py-2 text-sm">
            <div className="flex items-center gap-2 font-mono">
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-semibold text-foreground">{tool}</span>
              <span className="text-muted-foreground">({args})</span>
            </div>
            <span className="text-xs text-muted-foreground">{meta}</span>
          </div>
          {children && (
            <div className="border-t border-violet-100/80 px-3 py-3 bg-background/40">
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CoPilotPanel() {
  return (
    <div className="flex-1 min-h-0 p-6 bg-card">
      <Card className="h-full flex flex-col overflow-hidden bg-muted/30 min-h-0 rounded-2xl border shadow-sm">
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

function ComingSoonPanel({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center">
        <p className="text-lg font-medium">{label}</p>
        <p className="text-sm">Coming soon.</p>
      </div>
    </div>
  );
}
