'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkspacePush } from '@/hooks/useWorkspaceHref';
import { useChatActions } from '@/components/chat/ChatProvider';
import { INSIGHT_TEMPLATE_TRIGGER } from '@/lib/insights/insightSlashCommand';
import { InsightView } from './InsightView';
import { InsightEmptyState } from './InsightEmptyState';
import { InsightList, type InsightListTab } from './InsightList';
import { InsightUpload } from './InsightUpload';
import { ChevronDown, LayoutList, Plus, Sparkles, Upload } from 'lucide-react';

export interface InsightHostProps {
  insightId?: string;
  view?: 'document' | 'list' | 'upload';
  /** The list view's open tab, from the `?tab=` query. */
  listTab?: InsightListTab;
}

export function InsightHost({
  insightId,
  view = 'document',
  listTab = 'insights',
}: InsightHostProps) {
  const push = useWorkspacePush();
  const { newChat, prefillComposer, setInsightTemplate, focusComposer } = useChatActions();

  // Pointing the copilot at part of the document is a MODE, armed from the
  // toolbar. The picker inside the frame does let a plain click on a real
  // control (`button`, `select`, an ARIA role) through, but an insight's own
  // controls are often plain divs — always-armed selection eats those, and the
  // document reads as broken. Disarmed, the insight is simply live; the
  // selected outlines stay painted so the next question's scope is still
  // visible.
  const [selectMode, setSelectMode] = useState(false);

  // The list view loads (and pages) its own rows, so leaving the document for
  // it is all an archive or delete needs.
  const handleArchive = () => {
    push('/insight/list');
  };

  // "Create with Copilot" hands off to the chat composer via the
  // `/insight-template` slash command; "Upload HTML file" is the one creation
  // path with its own page (`/insight/upload`). Both chat paths start a fresh
  // chat first — otherwise the request lands in whatever unrelated thread the
  // provider still holds.
  const handleNewInsight = () => {
    newChat();
    push('/chat');
    prefillComposer(`${INSIGHT_TEMPLATE_TRIGGER} `);
  };

  const handleUseTemplate = (tpl: { id: string; name: string }) => {
    // newChat clears the template, so it must run before setInsightTemplate.
    newChat();
    setInsightTemplate(tpl);
    push('/chat');
    focusComposer();
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* ── Page Header Toolbar ── */}
      <div className="border-b border-border bg-card px-6 py-2.5 flex items-center justify-between shadow-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant={view === 'list' ? 'default' : 'outline'}
            aria-current={view === 'list' ? 'page' : undefined}
            onClick={() => push('/insight/list')}
            className={
              view === 'list'
                ? 'h-8 gap-1.5'
                : 'h-8 gap-1.5 bg-card hover:bg-muted text-foreground border-border'
            }
          >
            <LayoutList className="h-4 w-4" />
            All insights
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5"
                data-testid="insight-new-menu"
              >
                <Plus className="h-4 w-4" />
                New insight
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem
                onSelect={handleNewInsight}
                data-testid="insight-new-copilot"
                className="cursor-pointer hover:bg-muted focus:bg-muted"
              >
                <Sparkles className="h-4 w-4 mr-2 text-muted-foreground" />
                Create with Copilot
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => push('/insight/upload')}
                data-testid="insight-new-upload"
                className="cursor-pointer hover:bg-muted focus:bg-muted"
              >
                <Upload className="h-4 w-4 mr-2 text-muted-foreground" />
                Upload HTML file
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Page Body ── */}
      {/* A column, so the list's file drop target can fill the page height. */}
      <div className="flex-1 flex flex-col">
        {view === 'upload' ? (
          <InsightUpload />
        ) : view === 'document' ? (
          // Each view loads its own data: the document its insight, the list
          // its pages of rows.
          insightId ? (
            /* Active InsightView: MUST have key={insightId} */
            <InsightView
              key={insightId}
              insightId={insightId}
              selectMode={selectMode}
              onToggleSelectMode={() => setSelectMode((on) => !on)}
              onArchive={handleArchive}
            />
          ) : (
            <InsightEmptyState onNewInsight={handleNewInsight} />
          )
        ) : (
          <InsightList
            onNewInsight={handleNewInsight}
            onUseTemplate={handleUseTemplate}
            initialTab={listTab}
          />
        )}
      </div>
    </div>
  );
}
