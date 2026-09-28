'use client';

import { useRef } from 'react';
import { Slash } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { HtmlHoverPreview } from '@/components/insights/HtmlHoverPreview';
import { getTemplateIconComponent } from '@/components/insights/InsightTemplateIconSelect';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { createLruCache } from '@/lib/insights/lruCache';
import { getInsightTemplateHtml, type InsightTemplateSummary } from '@/lib/api/insightTemplates';
import type { SlashCommandDefinition } from '@/lib/chat/slashCommand';

// Module-level, mirroring InsightTemplateList.tsx's own `templatePreviewCache`
// — kept separate (not shared across the two views), cheap and per-view.
const templatePopupPreviewCache = createLruCache(24);

interface InsightTemplatePopupProps {
  /** Whether the popup should be open. */
  open: boolean;
  /**
   * `'palette'`: the leading "/" hasn't fully matched a registered command
   * yet — show command names. `'command'`: it has (currently only
   * `/insight-template` exists) — show that command's own content.
   */
  stage: 'palette' | 'command';
  /** Command names to show in the palette, already filtered by what's typed after "/". */
  paletteCommands: SlashCommandDefinition[];
  /** True while the initial template fetch is in flight. */
  loading: boolean;
  /** Whether the workspace has any templates at all (independent of the current filter). */
  hasAnyTemplates: boolean;
  /** The filtered template list to render in the `'command'` stage. */
  filtered: InsightTemplateSummary[];
  /** Index into whichever list (`paletteCommands` or `filtered`) is showing, for the keyboard/hover highlight. */
  highlightedIndex: number;
  /** Called when hover moves the highlight (keyboard nav is driven by the parent). */
  onHighlightChange: (index: number) => void;
  /** Called when a palette row is chosen (click, or Enter/Tab from the parent's keydown handler). */
  onSelectCommand: (command: SlashCommandDefinition) => void;
  /** Called when a template row is chosen (click, or Enter/Tab from the parent's keydown handler). */
  onSelectTemplate: (tpl: InsightTemplateSummary) => void;
  /** Called when the popup should close without a selection (Escape, outside click). */
  onDismiss: () => void;
  /** The composer row this popup is anchored below. */
  children: React.ReactNode;
}

/**
 * Purely presentational: all fetching/caching/filtering state lives in
 * `ChatInput` so the popup and its keyboard-handling logic share one source
 * of truth for the filtered list. Anchored to the composer row it wraps
 * (`children`), opening below it — matching the sketch this was built from,
 * not caret-following.
 *
 * Hosts both slash-command stages. A future second command adds its own
 * entry to the registry passed as `paletteCommands`'s source and, once
 * active, its own content branch here alongside the template list.
 */
export function InsightTemplatePopup({
  open,
  stage,
  paletteCommands,
  loading,
  hasAnyTemplates,
  filtered,
  highlightedIndex,
  onHighlightChange,
  onSelectCommand,
  onSelectTemplate,
  onDismiss,
  children,
}: InsightTemplatePopupProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const highlightedValue =
    stage === 'palette'
      ? paletteCommands[highlightedIndex]?.trigger
      : filtered[highlightedIndex]?.id;

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <PopoverAnchor asChild>
        <div ref={anchorRef}>{children}</div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-[--radix-popover-trigger-width] p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          // The user is still typing in the composer — a click there isn't a
          // dismissal, it's the whole point of the flow.
          if (anchorRef.current?.contains(e.target as Node)) {
            e.preventDefault();
          }
        }}
      >
        <Command
          shouldFilter={false}
          value={highlightedValue}
          onValueChange={(value) => {
            const list = stage === 'palette' ? paletteCommands.map((c) => c.trigger) : filtered.map((t) => t.id);
            const idx = list.indexOf(value);
            if (idx !== -1) onHighlightChange(idx);
          }}
        >
          <CommandList className="max-h-64">
            {stage === 'palette' ? (
              paletteCommands.length === 0 ? (
                <CommandEmpty>No matching commands.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {paletteCommands.map((command) => (
                    <CommandItem
                      key={command.trigger}
                      value={command.trigger}
                      onSelect={() => onSelectCommand(command)}
                    >
                      <Slash className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{command.label}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {command.trigger}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            ) : loading ? (
              <CommandEmpty>Loading templates…</CommandEmpty>
            ) : filtered.length === 0 ? (
              <CommandEmpty>
                {hasAnyTemplates ? (
                  'No matching templates.'
                ) : (
                  <div className="flex flex-col items-center gap-1.5">
                    <span>No insight templates yet.</span>
                    <WorkspaceLink
                      href="/insight/list"
                      className="text-primary hover:underline text-xs"
                    >
                      Manage templates →
                    </WorkspaceLink>
                  </div>
                )}
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {filtered.map((tpl) => {
                  const Icon = getTemplateIconComponent(tpl.icon);
                  return (
                    <HtmlHoverPreview
                      key={tpl.id}
                      id={tpl.id}
                      cacheKey={`${tpl.id}:${tpl.updated_at}`}
                      title={tpl.name}
                      fetchHtml={getInsightTemplateHtml}
                      cache={templatePopupPreviewCache}
                    >
                      <CommandItem value={tpl.id} onSelect={() => onSelectTemplate(tpl)}>
                        <Icon className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{tpl.name}</span>
                      </CommandItem>
                    </HtmlHoverPreview>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
          <div className="flex items-center gap-3 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
            <span>↑↓ navigate</span>
            <span>·</span>
            <span>↵ select</span>
            <span>·</span>
            <span>esc dismiss</span>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
