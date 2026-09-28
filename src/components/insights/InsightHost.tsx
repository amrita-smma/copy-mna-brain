'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkspacePush } from '@/hooks/useWorkspaceHref';
import { useChatContext } from '@/components/chat/ChatProvider';
import { INSIGHT_TEMPLATE_TRIGGER } from '@/lib/insights/insightSlashCommand';
import { InsightView } from './InsightView';
import { InsightEmptyState } from './InsightEmptyState';
import { InsightList, type InsightListTab } from './InsightList';
import { Plus, LayoutList } from 'lucide-react';

export interface InsightHostProps {
  insightId?: string;
  view?: 'document' | 'list';
  /** The list view's open tab, from the `?tab=` query. */
  listTab?: InsightListTab;
}

export function InsightHost({
  insightId,
  view = 'document',
  listTab = 'insights',
}: InsightHostProps) {
  const push = useWorkspacePush();
  const { newChat, prefillComposer, setInsightTemplate, focusComposer } = useChatContext();

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

  // Insight creation now happens in Copilot, not a dedicated page: hand off
  // to the chat composer via the `/insight-template` slash command instead
  // of navigating to a route. Both start a fresh chat first — otherwise the
  // request lands in whatever unrelated thread the provider still holds.
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
          <Button
            type="button"
            size="sm"
            onClick={handleNewInsight}
            className="h-8 gap-1.5"
          >
            <Plus className="h-4 w-4" />
            New insight
          </Button>
        </div>
      </div>

      {/* ── Page Body ── */}
      <div className="flex-1">
        {view === 'document' ? (
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
