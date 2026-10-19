'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Download,
  ExternalLink,
  Eye,
  FileText,
  Flag,
  History,
  Link as LinkIcon,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  StickyNote,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
  /**
   * `occurredAt` is the ISO instant the composer's override pill is set to, so
   * an entry written today about last Friday lands on last Friday. `null` is
   * the ordinary case — the entry is stamped with the moment it was added.
   */
  onAddNote: (occurredAt: string | null) => void;
  /** Manual entry — link composer. */
  newLinkUrl: string;
  newLinkTitle: string;
  onNewLinkUrlChange: (value: string) => void;
  onNewLinkTitleChange: (value: string) => void;
  onAddLink: (occurredAt: string | null) => void;
  /** Manual entry — file upload. */
  onUploadFile: (e: React.ChangeEvent<HTMLInputElement>, occurredAt: string | null) => void;
  /** True while any composer action is in flight. */
  isSubmitting: boolean;

  /** Rewrites a note's body in place. */
  onEditNote: (id: string, content: string) => Promise<void> | void;
  onDeleteNote: (id: string) => void;
  onDeleteLink: (id: string) => void;
  onDownloadDocument: (doc: D) => void;
  onPreviewDocument: (doc: D) => void;
  onDeleteDocument: (doc: D) => void;
  onDownloadMatchedFile: (file: F) => void;
  onPreviewMatchedFile: (file: F) => void;
  onOpenMatchedFile: (file: F) => void;

  /** `dialog` tightens the panes for the pipeline company dialog. */
  variant?: 'page' | 'dialog';
}

/** How many entries the rail shows before "Load more…" extends it. */
const PAGE_SIZE = 20;

const KIND_META: Record<
  TimelineEvent<TimelineDocumentItem, TimelineFileItem>['kind'],
  { label: string; short: string; icon: typeof FileText; dot: string; ring: string; text: string }
> = {
  note: {
    label: 'Note',
    short: 'Note',
    icon: StickyNote,
    dot: 'bg-blue-500',
    ring: 'ring-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
  },
  document: {
    label: 'Upload',
    short: 'Upload',
    icon: Upload,
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  link: {
    label: 'Link',
    short: 'Link',
    icon: LinkIcon,
    dot: 'bg-violet-500',
    ring: 'ring-violet-500',
    text: 'text-violet-600 dark:text-violet-400',
  },
  file: {
    label: 'File reference',
    short: 'File',
    icon: FileText,
    dot: 'bg-amber-500',
    ring: 'ring-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  stage: {
    label: 'Stage change',
    short: 'Stage',
    icon: Flag,
    dot: 'bg-primary',
    ring: 'ring-primary',
    text: 'text-primary',
  },
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

/** `2026-10-12` in the browser's own zone — what a date input expects. */
const toDateInput = (d: Date) => format(d, 'yyyy-MM-dd');
/** `11:39` in the browser's own zone — what a time input expects. */
const toTimeInput = (d: Date) => format(d, 'HH:mm');

/**
 * Combines the composer's two inputs into one instant, or `null` when they do
 * not make one — a cleared date input, say. Both are read in the browser's own
 * zone, so the entry lands on the wall-clock moment the author picked rather
 * than a UTC-shifted one.
 *
 * Returning `null` rather than falling back to `now` is the point: an author
 * who cleared the date is mid-edit, and silently stamping the entry with the
 * present is the one outcome they cannot see happening.
 */
const composeOccurredAt = (date: string, time: string): string | null => {
  if (!date) return null;
  const parsed = new Date(`${date}T${time || '00:00'}`);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Every dated thing that happened on a deal — stage changes, notes, uploaded
 * documents, links, and Smart Files that mention the company — as a vertical
 * rail of entries, newest first, beside a reading pane for whichever entry is
 * selected.
 *
 * It also owns manual entry: the composer above the rail writes a note, a link
 * or an upload, each stamped with the date/time its pill is set to, so the
 * Attachments tab it replaced has no surviving affordance of its own.
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
  onEditNote,
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
  // The composer stays collapsed behind the + in its header until asked for.
  const [composerOpen, setComposerOpen] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // An entry is stamped with the moment it was added unless the author opts
  // into overriding it. The pill behind that toggle is re-seeded to "now" each
  // time it opens, then left alone, so an author stamping several entries to
  // the same past moment does not have to re-pick it between each one.
  const [overrideTime, setOverrideTime] = useState(false);
  const [entryDate, setEntryDate] = useState(() => toDateInput(new Date()));
  const [entryTime, setEntryTime] = useState(() => toTimeInput(new Date()));

  // null carries two different meanings, and only the composer can tell them
  // apart: with the override off it means "stamp it now", which is a perfectly
  // good thing to submit; with the override on it means the author cleared the
  // date, which is not.
  const occurredAt = overrideTime ? composeOccurredAt(entryDate, entryTime) : null;
  const overrideIncomplete = overrideTime && occurredAt === null;
  const canSubmit = !isSubmitting && !overrideIncomplete;

  const toggleOverrideTime = (next: boolean) => {
    if (next) {
      const now = new Date();
      setEntryDate(toDateInput(now));
      setEntryTime(toTimeInput(now));
    }
    setOverrideTime(next);
  };

  // Note editing lives here rather than in the parents: the body being edited
  // is per-selection state, and resets whenever the selection moves.
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TimelineEvent<D, F> | null>(null);

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

    // Newest first, top to bottom, so the rail opens on what just happened and
    // "Load more…" reaches back in time. Undated rows sort to the end rather
    // than to 1970, so a missing timestamp never fakes an ancient event.
    return all.sort((a, b) => {
      const ta = safeDate(a.at)?.getTime();
      const tb = safeDate(b.at)?.getTime();
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return tb - ta;
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
    setIsEditing(false);
  }, [selectedKey]);

  // A selected entry further down the rail must stay reachable after a refetch
  // reorders it; extend the window rather than hiding what the user is reading.
  useEffect(() => {
    if (selectedIndex >= visibleCount) setVisibleCount(selectedIndex + 1);
  }, [selectedIndex, visibleCount]);

  // Reveal whatever the composer just added. A backdated entry sorts to its own
  // date, which on a long deal is well outside the first window — without this
  // the author gets a success toast and an unchanged rail. The new row is found
  // by diffing against the previous render's keys rather than from a returned
  // id, so one path covers notes, links and uploads alike.
  //
  // It only fires for a submit this component made: the parents also refetch in
  // the background (document processing polls), and a Smart File match landing
  // on its own must not move a selection the reader did not ask to move.
  const seenKeysRef = useRef<Set<string>>(new Set());
  const awaitingComposerAddRef = useRef(false);
  useEffect(() => {
    const previous = seenKeysRef.current;
    seenKeysRef.current = new Set(events.map((e) => e.key));
    if (!awaitingComposerAddRef.current) return;

    const addedIndex = events.findIndex((e) => !previous.has(e.key));
    if (addedIndex === -1) return;

    awaitingComposerAddRef.current = false;
    setVisibleCount((prev) => Math.max(prev, addedIndex + 1));
    setSelectedKey(events[addedIndex].key);
  }, [events]);

  const visibleEvents = events.slice(0, visibleCount);
  const hasMore = events.length > visibleEvents.length;

  const addNote = () => {
    if (overrideIncomplete) return;
    awaitingComposerAddRef.current = true;
    onAddNote(occurredAt);
  };

  const addLink = () => {
    if (overrideIncomplete) return;
    awaitingComposerAddRef.current = true;
    onAddLink(occurredAt);
  };

  const uploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (overrideIncomplete) return;
    awaitingComposerAddRef.current = true;
    onUploadFile(e, occurredAt);
  };

  const startEdit = () => {
    if (selected?.kind !== 'note') return;
    setEditBody(selected.item.content);
    setIsEditing(true);
  };

  const saveEdit = async () => {
    if (selected?.kind !== 'note' || !editBody.trim()) return;
    setIsSavingEdit(true);
    try {
      await onEditNote(selected.item.id, editBody);
      setIsEditing(false);
    } catch {
      // The parent has already surfaced the failure; stay in edit mode so the
      // unsaved body is not thrown away.
    } finally {
      setIsSavingEdit(false);
    }
  };

  const confirmDelete = () => {
    const event = pendingDelete;
    setPendingDelete(null);
    if (!event) return;
    if (event.kind === 'note') onDeleteNote(event.item.id);
    else if (event.kind === 'link') onDeleteLink(event.item.id);
    else if (event.kind === 'document') onDeleteDocument(event.item);
  };

  return (
    // The reading pane is stretched to a fixed minimum height, so the two cards
    // reach much further down the page than their content does and would
    // otherwise end flush against the bottom of the scroll area — the page
    // background reads as cut off rather than as space around the cards.
    // In the dialog the cards instead grow to the bottom of the modal: the
    // parent's TabsContent is a flex column, and the rail row takes the rest.
    <div className={cn('space-y-5', isDialog ? 'flex flex-1 flex-col lg:min-h-0' : 'pb-6')}>
      {/* Manual entry — a note, a link, or a file, all landing on the rail. */}
      <div
        className={cn(
          'rounded-lg border bg-card p-4 space-y-3',
          isDialog && 'shrink-0',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Add to timeline</p>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setComposerOpen((open) => !open)}
            title={composerOpen ? 'Close' : 'Add to timeline'}
            aria-expanded={composerOpen}
          >
            {composerOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </Button>
        </div>
        {composerOpen && (
          <>
            <Textarea
              placeholder="Write a timeline entry…"
              value={newNote}
              onChange={(e) => onNewNoteChange(e.target.value)}
              rows={isDialog ? 2 : 3}
              className={isDialog ? 'min-h-[60px]' : 'min-h-[90px]'}
            />
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
                  onClick={addLink}
                  disabled={!canSubmit || !newLinkUrl.trim()}
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
            {/* Stamping an entry with anything other than the moment it was added
                is the exception, so the pickers stay behind this toggle rather than
                asking every author to confirm "now". They sit on their own row:
                revealed inside the action row, the pill wrapped "Add entry" onto a
                line of its own at dialog width. */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="timeline-override-time"
                  checked={overrideTime}
                  onCheckedChange={(checked) => toggleOverrideTime(checked === true)}
                />
                <Label
                  htmlFor="timeline-override-time"
                  className="cursor-pointer text-sm font-normal text-muted-foreground"
                >
                  Override note time
                </Label>
              </div>
              {overrideTime && (
                <div className="flex h-9 items-center overflow-hidden rounded-md border border-primary bg-card text-primary">
                  <input
                    type="date"
                    aria-label="Entry date"
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    className="h-full cursor-pointer bg-transparent px-2 text-sm outline-none dark:[color-scheme:dark]"
                  />
                  <span className="h-full w-px bg-primary/30" />
                  <input
                    type="time"
                    aria-label="Entry time"
                    value={entryTime}
                    onChange={(e) => setEntryTime(e.target.value)}
                    className="h-full cursor-pointer bg-transparent px-2 text-sm outline-none dark:[color-scheme:dark]"
                  />
                </div>
              )}
              {overrideIncomplete && (
                <p className="text-xs text-destructive">
                  Pick a date, or switch the override off to stamp it with now.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Label htmlFor="timeline-file-upload" className="cursor-pointer">
                <Button variant="ghost" size="sm" disabled={!canSubmit} asChild>
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
                onChange={uploadFile}
                disabled={!canSubmit}
              />
              <Button variant="ghost" size="sm" onClick={() => setShowLinkForm((prev) => !prev)}>
                <LinkIcon className="h-4 w-4 mr-2" />
                {showLinkForm ? 'Cancel link' : 'Add link'}
              </Button>
              <Button onClick={addNote} disabled={!canSubmit || !newNote.trim()} size="sm">
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Plus className="h-4 w-4 mr-2" />
                )}
                Add entry
              </Button>
            </div>
          </>
        )}
      </div>

      {/* The rail beside its reading pane. */}
      <div
        className={cn(
          'flex flex-col gap-5 lg:flex-row lg:items-stretch',
          isDialog ? 'lg:min-h-[420px] lg:flex-1' : 'lg:min-h-[560px]',
        )}
      >
        <aside
          className={cn(
            'flex flex-col rounded-lg border bg-card p-4 lg:w-[260px] lg:shrink-0',
            isDialog && 'lg:min-h-0',
          )}
        >
          <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {events.length} event{events.length === 1 ? '' : 's'}
          </p>

          {events.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              Nothing here yet — use + above to add a note, a link, or a file.
            </p>
          ) : (
            <>
              <div
                className={cn(
                  'scrollbar-quiet relative flex-1 overflow-y-auto pl-1',
                  isDialog ? 'max-h-[360px] lg:max-h-none' : 'lg:max-h-[520px]',
                )}
              >
                {/* The rail itself, drawn on the list rather than the scroll
                    box so it spans every entry instead of only the visible
                    window. `left-[5px]` is the dot's centre: 10px wide, and
                    the list starts at the box's 4px left padding. */}
                <ul className="relative flex flex-col gap-2 before:absolute before:bottom-1.5 before:left-[5px] before:top-1.5 before:w-px before:bg-border">
                  {visibleEvents.map((event) => {
                    const meta = KIND_META[event.kind];
                    const isSelected = event.key === selectedKey;
                    const hasFile = event.kind === 'document' || event.kind === 'file';
                    const hasLink = event.kind === 'link';
                    return (
                      <li key={event.key} className="flex items-start gap-2.5">
                        <span
                          className={cn(
                            'z-10 mt-2.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-card ring-2',
                            meta.dot,
                            isSelected ? meta.ring : 'ring-transparent',
                          )}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedKey((prev) =>
                              prev === event.key ? null : event.key,
                            )
                          }
                          title={event.title}
                          className={cn(
                            'flex min-w-0 flex-1 flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors',
                            isSelected
                              ? 'border-primary bg-muted ring-1 ring-primary'
                              : 'border-transparent bg-card hover:bg-muted',
                          )}
                        >
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                'text-[11px] font-semibold tracking-wide',
                                isSelected ? 'text-primary' : meta.text,
                              )}
                            >
                              {meta.short}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {formatAt(event.at, 'd MMM yy')}
                            </span>
                            {hasFile && (
                              <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                            )}
                            {hasLink && (
                              <LinkIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                            )}
                          </span>
                          <span
                            className={cn(
                              'line-clamp-2 text-xs',
                              isSelected ? 'font-medium text-primary' : 'text-foreground',
                            )}
                          >
                            {event.title}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {hasMore && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                >
                  Load more…
                </Button>
              )}
            </>
          )}
        </aside>

        <section
          className={cn(
            'scrollbar-quiet min-w-0 flex-1 overflow-y-auto rounded-lg border bg-card p-5',
            isDialog && 'lg:min-h-0',
          )}
        >
          {selected ? (
            <EventDetail
              event={selected}
              getStageLabel={getStageLabel}
              insightsOpen={insightsOpen}
              onToggleInsights={() => setInsightsOpen((prev) => !prev)}
              tagsExpanded={tagsExpanded}
              onToggleTags={() => setTagsExpanded((prev) => !prev)}
              onClose={() => setSelectedKey(null)}
              isEditing={isEditing}
              editBody={editBody}
              isSavingEdit={isSavingEdit}
              onStartEdit={startEdit}
              onEditBodyChange={setEditBody}
              onCancelEdit={() => setIsEditing(false)}
              onSaveEdit={saveEdit}
              onRequestDelete={() => setPendingDelete(selected)}
              onDownloadDocument={onDownloadDocument}
              onPreviewDocument={onPreviewDocument}
              onDownloadMatchedFile={onDownloadMatchedFile}
              onPreviewMatchedFile={onPreviewMatchedFile}
              onOpenMatchedFile={onOpenMatchedFile}
            />
          ) : (
            <div className="flex h-full items-center justify-center py-10">
              <div className="max-w-xs text-center">
                <History className="mx-auto h-7 w-7 text-muted-foreground" />
                <p className="mt-3.5 text-base font-semibold">No entry selected</p>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  Add a new entry above, or select an existing one from the timeline on the
                  left to view its details.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      {pendingDelete && (
        <AlertDialog
          key={pendingDelete.key}
          open={!!pendingDelete}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes it from the deal timeline permanently. This can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
  isEditing: boolean;
  editBody: string;
  isSavingEdit: boolean;
  onStartEdit: () => void;
  onEditBodyChange: (value: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRequestDelete: () => void;
  onDownloadDocument: (doc: D) => void;
  onPreviewDocument: (doc: D) => void;
  onDownloadMatchedFile: (file: F) => void;
  onPreviewMatchedFile: (file: F) => void;
  onOpenMatchedFile: (file: F) => void;
}

/** The reading pane for whichever entry is selected. */
function EventDetail<D extends TimelineDocumentItem, F extends TimelineFileItem>({
  event,
  getStageLabel,
  insightsOpen,
  onToggleInsights,
  tagsExpanded,
  onToggleTags,
  onClose,
  isEditing,
  editBody,
  isSavingEdit,
  onStartEdit,
  onEditBodyChange,
  onCancelEdit,
  onSaveEdit,
  onRequestDelete,
  onDownloadDocument,
  onPreviewDocument,
  onDownloadMatchedFile,
  onPreviewMatchedFile,
  onOpenMatchedFile,
}: EventDetailProps<D, F>) {
  const meta = KIND_META[event.kind];
  const canEdit = event.kind === 'note';
  const canDelete = event.kind === 'note' || event.kind === 'link' || event.kind === 'document';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold">{event.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {meta.label} · {formatAt(event.at, 'MMM d, yyyy HH:mm')}
            {formatRelative(event.at) && ` · ${formatRelative(event.at)}`}
          </p>
          {event.kind === 'link' && (
            <a
              href={event.item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex max-w-[320px] items-center gap-1.5 rounded-full border bg-muted px-2.5 py-1 text-xs text-primary hover:underline"
            >
              <LinkIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{event.item.url}</span>
            </a>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canEdit && !isEditing && (
            <Button variant="ghost" size="sm" onClick={onStartEdit}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              title="Delete"
              onClick={onRequestDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Close"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {event.kind === 'stage' && (
        <div className="flex items-center gap-2">
          <Badge variant="outline">{getStageLabel(event.item.stage)}</Badge>
          <span className="text-xs text-muted-foreground">
            Entered {formatAt(event.item.entered_at, 'MMM d, yyyy HH:mm')}
          </span>
        </div>
      )}

      {event.kind === 'note' &&
        (isEditing ? (
          <div className="space-y-3">
            <Textarea
              value={editBody}
              onChange={(e) => onEditBodyChange(e.target.value)}
              className="min-h-[220px] leading-relaxed"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onCancelEdit} disabled={isSavingEdit}>
                Cancel
              </Button>
              <Button size="sm" onClick={onSaveEdit} disabled={isSavingEdit || !editBody.trim()}>
                {isSavingEdit && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{event.item.content}</p>
            <Badge variant="outline" className="text-xs">
              {getStageLabel(event.item.stage)}
            </Badge>
          </div>
        ))}

      {event.kind === 'document' && (
        <div className="space-y-3">
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
        <Badge variant="outline" className="text-xs">
          {getStageLabel(event.item.stage)}
        </Badge>
      )}

      {event.kind === 'file' && (
        <div className="space-y-3">
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
