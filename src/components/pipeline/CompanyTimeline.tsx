'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Flag,
  Link as LinkIcon,
  Loader2,
  Plus,
  StickyNote,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  DocumentStatusBadge,
  DocumentTagsList,
  DocumentInsightsPanel,
  hasDocumentInsights,
} from '@/components/Files/DocumentInsightsPanel';
import { cn } from '@/lib/utils';

/** A dated note recorded on the deal. */
export interface TimelineNoteItem {
  id: string;
  content: string;
  stage: string;
  created_at: string | null;
}

/** A file uploaded against the deal (`deal_documents`). */
export interface TimelineDocumentItem {
  id: string;
  file_name: string;
  stage: string;
  created_at: string | null;
  structured_notes: string | null;
  tags: string[] | null;
  processing_status: string | null;
  is_featured: boolean;
}

/** A URL attached to the deal. */
export interface TimelineLinkItem {
  id: string;
  url: string;
  title: string | null;
  stage: string;
  created_at: string | null;
}

/** A Smart File that references this company (`files.matched_companies`). */
export interface TimelineFileItem {
  id: string;
  file_name: string;
  file_date: string | null;
  created_at: string;
}

/** One stage entry derived from `company_logs`. */
export interface TimelineStageItem {
  id: string;
  stage: string;
  entered_at: string;
}

type TimelineEvent<D, F> =
  | { key: string; kind: 'note'; at: string; title: string; item: TimelineNoteItem }
  | { key: string; kind: 'document'; at: string; title: string; item: D }
  | { key: string; kind: 'link'; at: string; title: string; item: TimelineLinkItem }
  | { key: string; kind: 'file'; at: string; title: string; item: F }
  | { key: string; kind: 'stage'; at: string; title: string; item: TimelineStageItem };

interface CompanyTimelineProps<D extends TimelineDocumentItem, F extends TimelineFileItem> {
  notes: TimelineNoteItem[];
  documents: D[];
  links: TimelineLinkItem[];
  matchedFiles: F[];
  stageHistory: TimelineStageItem[];
  /** Resolves a raw stage key (`L1`) to its workspace label. */
  getStageLabel: (stage: string | null) => string;

  /** Manual entry — note composer. */
  newNote: string;
  onNewNoteChange: (value: string) => void;
  onAddNote: () => void;
  /** Manual entry — link composer. */
  newLinkUrl: string;
  newLinkTitle: string;
  onNewLinkUrlChange: (value: string) => void;
  onNewLinkTitleChange: (value: string) => void;
  onAddLink: () => void;
  /** Manual entry — file upload. */
  onUploadFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** True while any composer action is in flight. */
  isSubmitting: boolean;

  onDeleteNote: (id: string) => void;
  onDeleteLink: (id: string) => void;
  onDownloadDocument: (doc: D) => void;
  onPreviewDocument: (doc: D) => void;
  onDeleteDocument: (doc: D) => void;
  onDownloadMatchedFile: (file: F) => void;
  onPreviewMatchedFile: (file: F) => void;
  onOpenMatchedFile: (file: F) => void;

  /** `dialog` tightens the rail for the pipeline company dialog. */
  variant?: 'page' | 'dialog';
}

/** Marker column width in px — must match `w-44` below; used to place the caret. */
const ITEM_WIDTH = 176;

const KIND_META: Record<
  TimelineEvent<TimelineDocumentItem, TimelineFileItem>['kind'],
  { label: string; icon: typeof FileText; dot: string; text: string }
> = {
  note: { label: 'Note', icon: StickyNote, dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400' },
  document: { label: 'Upload', icon: Upload, dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  link: { label: 'Link', icon: LinkIcon, dot: 'bg-violet-500', text: 'text-violet-600 dark:text-violet-400' },
  file: { label: 'File reference', icon: FileText, dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  stage: { label: 'Stage change', icon: Flag, dot: 'bg-primary', text: 'text-primary' },
};

const safeDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};

const formatAt = (value: string, pattern = 'MMM d, yyyy') => {
  const d = safeDate(value);
  return d ? format(d, pattern) : '—';
};

const formatRelative = (value: string) => {
  const d = safeDate(value);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : '';
};

/**
 * A classic horizontal timeline of everything that happened on a deal — stage
 * changes, notes, uploaded documents, links, and Smart Files that mention the
 * company — ordered oldest to newest along a single rail. Clicking a marker
 * expands that event's detail into the panel beneath the rail.
 *
 * It also owns manual entry: a note textbox, a link form, and a file upload,
 * so the Attachments tab it replaced has no surviving affordance of its own.
 *
 * Shared by `CompanyDetail` (full page) and `CompanyDetailDialog` (pipeline
 * dialog) so the two Timeline tabs cannot drift apart.
 */
export function CompanyTimeline<
  D extends TimelineDocumentItem,
  F extends TimelineFileItem,
>({
  notes,
  documents,
  links,
  matchedFiles,
  stageHistory,
  getStageLabel,
  newNote,
  onNewNoteChange,
  onAddNote,
  newLinkUrl,
  newLinkTitle,
  onNewLinkUrlChange,
  onNewLinkTitleChange,
  onAddLink,
  onUploadFile,
  isSubmitting,
  onDeleteNote,
  onDeleteLink,
  onDownloadDocument,
  onPreviewDocument,
  onDeleteDocument,
  onDownloadMatchedFile,
  onPreviewMatchedFile,
  onOpenMatchedFile,
  variant = 'page',
}: CompanyTimelineProps<D, F>) {
  const isDialog = variant === 'dialog';
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  // Only auto-scroll to the newest event once per mount, so a refetch after
  // adding an entry cannot yank the rail away from where the user scrolled.
  const didAutoScrollRef = useRef(false);

  const events = useMemo<TimelineEvent<D, F>[]>(() => {
    const all: TimelineEvent<D, F>[] = [];

    for (const stage of stageHistory) {
      all.push({
        key: `stage:${stage.id}`,
        kind: 'stage',
        at: stage.entered_at,
        title: `Moved to ${getStageLabel(stage.stage)}`,
        item: stage,
      });
    }
    for (const note of notes) {
      all.push({
        key: `note:${note.id}`,
        kind: 'note',
        at: note.created_at ?? '',
        title: note.content.trim().split('\n')[0] || 'Note',
        item: note,
      });
    }
    for (const doc of documents) {
      all.push({
        key: `document:${doc.id}`,
        kind: 'document',
        at: doc.created_at ?? '',
        title: doc.file_name,
        item: doc,
      });
    }
    for (const link of links) {
      all.push({
        key: `link:${link.id}`,
        kind: 'link',
        at: link.created_at ?? '',
        title: link.title || link.url,
        item: link,
      });
    }
    for (const file of matchedFiles) {
      all.push({
        key: `file:${file.id}`,
        kind: 'file',
        at: file.file_date ?? file.created_at,
        title: file.file_name,
        item: file,
      });
    }

    // Oldest first, left to right. Undated rows sort to the end rather than to
    // 1970, so a missing timestamp never fakes an ancient event.
    return all.sort((a, b) => {
      const ta = safeDate(a.at)?.getTime();
      const tb = safeDate(b.at)?.getTime();
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    });
  }, [notes, documents, links, matchedFiles, stageHistory, getStageLabel]);

  const selectedIndex = selectedKey ? events.findIndex((e) => e.key === selectedKey) : -1;
  const selected = selectedIndex >= 0 ? events[selectedIndex] : null;

  // A selected event can disappear underneath us (deleted, or refetched away).
  useEffect(() => {
    if (selectedKey && selectedIndex === -1) setSelectedKey(null);
  }, [selectedKey, selectedIndex]);

  // Reset per-event detail toggles when the selection moves.
  useEffect(() => {
    setInsightsOpen(false);
    setTagsExpanded(false);
  }, [selectedKey]);

  useEffect(() => {
    if (didAutoScrollRef.current || events.length === 0) return;
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollLeft = rail.scrollWidth;
    setScrollLeft(rail.scrollLeft);
    didAutoScrollRef.current = true;
  }, [events.length]);

  const scrollRail = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * ITEM_WIDTH * 3, behavior: 'smooth' });
  };

  const caretLeft =
    selectedIndex >= 0 ? selectedIndex * ITEM_WIDTH + ITEM_WIDTH / 2 - scrollLeft : null;

  return (
    <div className="space-y-4">
      {/* Manual entry — a note, a link, or a file, all landing on the rail. */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-sm font-semibold">Add to timeline</p>
        <Textarea
          placeholder="Write a timeline entry…"
          value={newNote}
          onChange={(e) => onNewNoteChange(e.target.value)}
          rows={isDialog ? 2 : 3}
          className={isDialog ? 'min-h-[60px]' : undefined}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onAddNote} disabled={isSubmitting || !newNote.trim()} size="sm">
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add entry
          </Button>
          <Label htmlFor="timeline-file-upload" className="cursor-pointer">
            <Button variant="outline" size="sm" disabled={isSubmitting} asChild>
              <span>
                <Upload className="h-4 w-4 mr-2" />
                Upload file
              </span>
            </Button>
          </Label>
          <Input
            id="timeline-file-upload"
            type="file"
            className="hidden"
            onChange={onUploadFile}
            disabled={isSubmitting}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowLinkForm((prev) => !prev)}
          >
            <LinkIcon className="h-4 w-4 mr-2" />
            {showLinkForm ? 'Cancel link' : 'Add link'}
          </Button>
        </div>
        {showLinkForm && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="https://..."
              value={newLinkUrl}
              onChange={(e) => onNewLinkUrlChange(e.target.value)}
              className="sm:flex-1"
            />
            <Input
              placeholder="Title (optional)"
              value={newLinkTitle}
              onChange={(e) => onNewLinkTitleChange(e.target.value)}
              className="sm:flex-1"
            />
            <Button
              onClick={onAddLink}
              disabled={isSubmitting || !newLinkUrl.trim()}
              size="sm"
              className="shrink-0"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Add link
            </Button>
          </div>
        )}
      </div>

      {/* The rail */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {events.length} event{events.length === 1 ? '' : 's'}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => scrollRail(-1)}
              title="Scroll back"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => scrollRail(1)}
              title="Scroll forward"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {events.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            Nothing on the timeline yet — add a note, a link, or upload a file above.
          </p>
        ) : (
          <>
            <div
              ref={railRef}
              onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
              className="overflow-x-auto overflow-y-hidden px-4 py-5"
            >
              <div className="flex min-w-full">
                {events.map((event, index) => {
                  const meta = KIND_META[event.kind];
                  const Icon = meta.icon;
                  const isSelected = event.key === selectedKey;
                  return (
                    <button
                      key={event.key}
                      type="button"
                      onClick={() =>
                        setSelectedKey((prev) => (prev === event.key ? null : event.key))
                      }
                      className="flex w-44 shrink-0 flex-col items-center gap-1 text-center"
                      title={event.title}
                    >
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {formatAt(event.at)}
                      </span>
                      <span className={cn('text-[10px] uppercase tracking-wide', meta.text)}>
                        {meta.label}
                      </span>
                      {/* Dot on the rail. The line is drawn as two segments
                          either side of it, so it always meets the dot's
                          centre without hard-coded offsets. */}
                      <span className="flex w-full items-center">
                        <span
                          className={cn(
                            'h-px flex-1',
                            index === 0 ? 'bg-transparent' : 'bg-border',
                          )}
                        />
                        <span
                          className={cn(
                            'h-4 w-4 shrink-0 rounded-full transition-transform',
                            meta.dot,
                            isSelected && 'scale-125',
                          )}
                        />
                        <span
                          className={cn(
                            'h-px flex-1',
                            index === events.length - 1 ? 'bg-transparent' : 'bg-border',
                          )}
                        />
                      </span>
                      <span
                        className={cn(
                          'mt-2 mx-2 flex items-center gap-1.5 self-stretch rounded-md border bg-muted px-2 py-1.5 text-left transition-colors',
                          isSelected
                            ? 'border-primary ring-1 ring-primary'
                            : 'hover:border-primary',
                        )}
                      >
                        <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.text)} />
                        <span className="min-w-0 truncate text-xs">{event.title}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Caret pointing at the selected marker; clipped at the rail edges
                so it never escapes the card when the rail is scrolled away. */}
            {selected && (
              <div className="relative h-2 overflow-hidden">
                {caretLeft !== null && (
                  <span
                    className="absolute top-0 -ml-2 h-0 w-0 border-x-8 border-b-8 border-x-transparent border-b-muted"
                    style={{ left: caretLeft + 16 }}
                  />
                )}
              </div>
            )}

            {selected && (
              <div className="border-t bg-muted px-4 py-4">
                <EventDetail
                  event={selected}
                  getStageLabel={getStageLabel}
                  insightsOpen={insightsOpen}
                  onToggleInsights={() => setInsightsOpen((prev) => !prev)}
                  tagsExpanded={tagsExpanded}
                  onToggleTags={() => setTagsExpanded((prev) => !prev)}
                  onClose={() => setSelectedKey(null)}
                  onDeleteNote={onDeleteNote}
                  onDeleteLink={onDeleteLink}
                  onDownloadDocument={onDownloadDocument}
                  onPreviewDocument={onPreviewDocument}
                  onDeleteDocument={onDeleteDocument}
                  onDownloadMatchedFile={onDownloadMatchedFile}
                  onPreviewMatchedFile={onPreviewMatchedFile}
                  onOpenMatchedFile={onOpenMatchedFile}
                />
              </div>
            )}
          </>
        )}
      </div>

      {events.length > 0 && !selected && (
        <p className="text-xs text-muted-foreground">
          Select an event on the rail to read it here.
        </p>
      )}
    </div>
  );
}

interface EventDetailProps<D extends TimelineDocumentItem, F extends TimelineFileItem> {
  event: TimelineEvent<D, F>;
  getStageLabel: (stage: string | null) => string;
  insightsOpen: boolean;
  onToggleInsights: () => void;
  tagsExpanded: boolean;
  onToggleTags: () => void;
  onClose: () => void;
  onDeleteNote: (id: string) => void;
  onDeleteLink: (id: string) => void;
  onDownloadDocument: (doc: D) => void;
  onPreviewDocument: (doc: D) => void;
  onDeleteDocument: (doc: D) => void;
  onDownloadMatchedFile: (file: F) => void;
  onPreviewMatchedFile: (file: F) => void;
  onOpenMatchedFile: (file: F) => void;
}

/** The expanded panel for whichever marker is selected. */
function EventDetail<D extends TimelineDocumentItem, F extends TimelineFileItem>({
  event,
  getStageLabel,
  insightsOpen,
  onToggleInsights,
  tagsExpanded,
  onToggleTags,
  onClose,
  onDeleteNote,
  onDeleteLink,
  onDownloadDocument,
  onPreviewDocument,
  onDeleteDocument,
  onDownloadMatchedFile,
  onPreviewMatchedFile,
  onOpenMatchedFile,
}: EventDetailProps<D, F>) {
  const meta = KIND_META[event.kind];
  const Icon = meta.icon;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', meta.text)} />
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{event.title}</p>
            <p className="text-xs text-muted-foreground">
              {meta.label} · {formatAt(event.at, 'MMM d, yyyy HH:mm')}
              {formatRelative(event.at) && ` · ${formatRelative(event.at)}`}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onClose}>
          Close
        </Button>
      </div>

      {event.kind === 'stage' && (
        <div className="flex items-center gap-2">
          <Badge variant="outline">{getStageLabel(event.item.stage)}</Badge>
          <span className="text-xs text-muted-foreground">
            Entered {formatAt(event.item.entered_at, 'MMM d, yyyy HH:mm')}
          </span>
        </div>
      )}

      {event.kind === 'note' && (
        <div className="space-y-2">
          <p className="text-sm whitespace-pre-wrap">{event.item.content}</p>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline" className="text-xs">
              {getStageLabel(event.item.stage)}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDeleteNote(event.item.id)}
            >
              <Trash2 className="h-4 w-4 mr-2 text-destructive" />
              Delete
            </Button>
          </div>
        </div>
      )}

      {event.kind === 'document' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <DocumentStatusBadge status={event.item.processing_status} />
            {event.item.is_featured && (
              <Badge variant="outline" className="text-xs gap-1">
                <Star className="h-3 w-3" />
                Featured slide
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {getStageLabel(event.item.stage)}
            </Badge>
            <DocumentTagsList
              tags={event.item.tags}
              expanded={tagsExpanded}
              onToggleExpand={onToggleTags}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onPreviewDocument(event.item)}>
              <Eye className="h-4 w-4 mr-2" />
              Preview
            </Button>
            <Button variant="outline" size="sm" onClick={() => onDownloadDocument(event.item)}>
              <Download className="h-4 w-4 mr-2" />
              Download
            </Button>
            {hasDocumentInsights(event.item) && (
              <Button variant="outline" size="sm" onClick={onToggleInsights}>
                <FileText className="h-4 w-4 mr-2" />
                {insightsOpen ? 'Hide insights' : 'Show insights'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onDeleteDocument(event.item)}>
              <Trash2 className="h-4 w-4 mr-2 text-destructive" />
              Delete
            </Button>
          </div>
          {insightsOpen && (
            <DocumentInsightsPanel
              structuredNotes={event.item.structured_notes}
              status={event.item.processing_status}
            />
          )}
        </div>
      )}

      {event.kind === 'link' && (
        <div className="space-y-2">
          <a
            href={event.item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-primary hover:underline break-all"
          >
            <ExternalLink className="h-4 w-4 shrink-0" />
            {event.item.url}
          </a>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline" className="text-xs">
              {getStageLabel(event.item.stage)}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => onDeleteLink(event.item.id)}>
              <Trash2 className="h-4 w-4 mr-2 text-destructive" />
              Delete
            </Button>
          </div>
        </div>
      )}

      {event.kind === 'file' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Referenced from Smart Files — this file mentions the company.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onPreviewMatchedFile(event.item)}>
              <Eye className="h-4 w-4 mr-2" />
              Preview
            </Button>
            <Button variant="outline" size="sm" onClick={() => onDownloadMatchedFile(event.item)}>
              <Download className="h-4 w-4 mr-2" />
              Download
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenMatchedFile(event.item)}>
              <ExternalLink className="h-4 w-4 mr-2" />
              Open in Smart Files
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CompanyTimeline;
