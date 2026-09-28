'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listInsightTemplates,
  listDeletedInsightTemplates,
  duplicateInsightTemplate,
  deleteInsightTemplate,
  deleteInsightTemplatePermanently,
  restoreInsightTemplate,
  getInsightTemplateHtml,
  type InsightTemplateSummary,
} from '@/lib/api/insightTemplates';
import { createLruCache } from '@/lib/insights/lruCache';
import { formatTemplateUsage } from '@/lib/insights/templateUsage';
import { InsightEmptyState } from './InsightEmptyState';
import { InsightTemplateUploadDialog } from './InsightTemplateUploadDialog';
import { InsightTemplateEditDialog } from './InsightTemplateEditDialog';
import { getTemplateIconComponent } from './InsightTemplateIconSelect';
import {
  InsightTemplatePreviewDialog,
  type TemplatePreviewTarget,
} from './InsightTemplatePreviewDialog';
import { HtmlHoverPreview } from './HtmlHoverPreview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  ArchiveRestore,
  Copy,
  Eye,
  FileText,
  Loader2,
  MoreVertical,
  Pencil,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { INSIGHT_TEMPLATE_MAX_CHARS } from '@/lib/insights/templateAttachment';

// Module-level: shared across remounts of this component within the tab,
// bounded so a long scroll through the list can't grow it unbounded.
const templatePreviewCache = createLruCache(24);

type TemplateSort = 'newest' | 'name' | 'most_used';

function formatTemplateDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Case-insensitive name/description filter, then the chosen order. */
function filterAndSortTemplates(
  templates: InsightTemplateSummary[],
  query: string,
  sort: TemplateSort,
): InsightTemplateSummary[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? templates.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q),
      )
    : templates;
  const newestFirst = (a: InsightTemplateSummary, b: InsightTemplateSummary) =>
    b.created_at.localeCompare(a.created_at);
  return [...matched].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (sort === 'most_used') {
      // Ties (including every unused template) fall back to newest first.
      return (b.usage_count ?? 0) - (a.usage_count ?? 0) || newestFirst(a, b);
    }
    return newestFirst(a, b);
  });
}

/** Keeps a click or key press inside a card's own control from opening the preview. */
const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

export interface InsightTemplateListProps {
  onUseTemplate?: (tpl: { id: string; name: string }) => void;
}

export function InsightTemplateList({ onUseTemplate }: InsightTemplateListProps) {
  const [templates, setTemplates] = useState<InsightTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<TemplateSort>('newest');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] =
    useState<InsightTemplateSummary | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [deletingTemplate, setDeletingTemplate] =
    useState<InsightTemplateSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [preview, setPreview] = useState<TemplatePreviewTarget | null>(null);

  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedTemplates, setDeletedTemplates] = useState<InsightTemplateSummary[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [purgingTemplate, setPurgingTemplate] =
    useState<InsightTemplateSummary | null>(null);
  const [isPurging, setIsPurging] = useState(false);

  const fetchTemplates = useCallback(async () => {
    try {
      setError(null);
      const data = await listInsightTemplates();
      setTemplates(data);
    } catch (err: unknown) {
      console.error('Failed to list insight templates', err);
      setError(
        err instanceof Error ? err.message : 'Failed to load templates',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDeleted = useCallback(async () => {
    setDeletedLoading(true);
    try {
      setDeletedTemplates(await listDeletedInsightTemplates());
    } catch (err: unknown) {
      console.error('Failed to list deleted insight templates', err);
      toast.error(err instanceof Error ? err.message : 'Failed to load deleted templates');
    } finally {
      setDeletedLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  useEffect(() => {
    if (showDeleted) void fetchDeleted();
  }, [showDeleted, fetchDeleted]);

  const visibleTemplates = useMemo(
    () => filterAndSortTemplates(templates, query, sort),
    [templates, query, sort],
  );

  const openPreview = (tpl: InsightTemplateSummary) => {
    setPreview({
      key: `${tpl.id}:${tpl.updated_at}`,
      title: tpl.name,
      subtitle: tpl.description ?? undefined,
      fetchHtml: () => getInsightTemplateHtml(tpl.id),
      onUseTemplate: onUseTemplate
        ? () => onUseTemplate({ id: tpl.id, name: tpl.name })
        : undefined,
    });
  };

  const handleDuplicate = async (tpl: InsightTemplateSummary) => {
    if (duplicatingId) return;
    setDuplicatingId(tpl.id);
    try {
      await duplicateInsightTemplate(tpl.id);
      toast.success('Template duplicated');
      await fetchTemplates();
    } catch (err: unknown) {
      console.error('Failed to duplicate template', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to duplicate template',
      );
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deletingTemplate || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteInsightTemplate(deletingTemplate.id);
      toast.success('Template moved to Recently deleted');
      setDeletingTemplate(null);
      await fetchTemplates();
      if (showDeleted) await fetchDeleted();
    } catch (err: unknown) {
      console.error('Failed to delete template', err);
      toast.error(
        err instanceof Error ? err.message : 'Failed to delete template',
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRestore = async (tpl: InsightTemplateSummary) => {
    if (restoringId) return;
    setRestoringId(tpl.id);
    try {
      await restoreInsightTemplate(tpl.id);
      toast.success('Template restored');
      await Promise.all([fetchTemplates(), fetchDeleted()]);
    } catch (err: unknown) {
      console.error('Failed to restore template', err);
      toast.error(err instanceof Error ? err.message : 'Failed to restore template');
    } finally {
      setRestoringId(null);
    }
  };

  const handlePurge = async () => {
    if (!purgingTemplate || isPurging) return;
    setIsPurging(true);
    try {
      await deleteInsightTemplatePermanently(purgingTemplate.id);
      toast.success('Template deleted forever');
      setPurgingTemplate(null);
      await fetchDeleted();
    } catch (err: unknown) {
      console.error('Failed to delete template permanently', err);
      toast.error(err instanceof Error ? err.message : 'Failed to delete template');
    } finally {
      setIsPurging(false);
    }
  };

  if (loading && templates.length === 0) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="ml-3 text-sm text-muted-foreground">
          Loading templates...
        </span>
      </div>
    );
  }

  if (error && templates.length === 0) {
    return (
      <div className="text-center p-12">
        <p className="text-sm text-destructive mb-4">{error}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setLoading(true);
            fetchTemplates();
          }}
        >
          Try Again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {templates.length} {templates.length === 1 ? 'template' : 'templates'}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowDeleted((v) => !v)}
            aria-pressed={showDeleted}
            className="gap-1.5 bg-card text-foreground border-border hover:bg-muted"
            data-testid="template-recently-deleted-toggle"
          >
            <Trash2 className="h-4 w-4" />
            {showDeleted ? 'Hide recently deleted' : 'Recently deleted'}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setUploadOpen(true)}
            className="gap-1.5"
          >
            <Upload className="h-4 w-4" />
            Upload Template
          </Button>
        </div>
      </div>

      {templates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates..."
              aria-label="Search templates"
              className="pl-8 bg-card text-foreground border border-input"
              data-testid="template-search-input"
            />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as TemplateSort)}>
            <SelectTrigger
              aria-label="Sort templates"
              className="w-[150px] bg-card text-foreground border border-input"
              data-testid="template-sort-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card text-foreground border border-border shadow-md">
              <SelectItem value="newest" className="cursor-pointer hover:bg-muted focus:bg-muted">
                Newest
              </SelectItem>
              <SelectItem value="name" className="cursor-pointer hover:bg-muted focus:bg-muted">
                Name A–Z
              </SelectItem>
              <SelectItem value="most_used" className="cursor-pointer hover:bg-muted focus:bg-muted">
                Most used
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {templates.length === 0 ? (
        <InsightEmptyState
          title="No Templates Yet"
          body={`Upload HTML template documents (up to ${INSIGHT_TEMPLATE_MAX_CHARS.toLocaleString('en-US')} characters) to structure and standardize your generated insights.`}
          actionLabel="Upload Template"
          icon={FileText}
          actionIcon={Upload}
          onNewInsight={() => setUploadOpen(true)}
        />
      ) : visibleTemplates.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No templates match &ldquo;{query.trim()}&rdquo;.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {visibleTemplates.map((tpl) => {
            const IconComp = getTemplateIconComponent(tpl.icon);
            return (
              <HtmlHoverPreview
                key={tpl.id}
                id={tpl.id}
                cacheKey={`${tpl.id}:${tpl.updated_at}`}
                title={tpl.name}
                fetchHtml={getInsightTemplateHtml}
                cache={templatePreviewCache}
              >
              {/* Focusable, so the hover preview also opens on keyboard focus. */}
              <div
                role="button"
                tabIndex={0}
                aria-label={`Preview ${tpl.name}`}
                onClick={() => openPreview(tpl)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPreview(tpl);
                  }
                }}
                className="rounded-xl border border-border bg-card p-5 shadow-sm flex flex-col gap-2.5 cursor-pointer transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="insight-template-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <IconComp className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <h3 className="font-semibold text-sm text-foreground leading-snug line-clamp-1">
                      {tpl.name}
                    </h3>
                  </div>
                  <div onClick={stopPropagation} onKeyDown={stopPropagation}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 -mr-1 -mt-1 text-muted-foreground hover:text-foreground"
                      >
                        <span className="sr-only">Template options</span>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="bg-card text-foreground border border-border shadow-md"
                      onClick={stopPropagation}
                      onKeyDown={stopPropagation}
                    >
                      <DropdownMenuItem
                        onClick={() => openPreview(tpl)}
                        className="cursor-pointer hover:bg-muted focus:bg-muted"
                      >
                        <Eye className="h-4 w-4 mr-2 text-muted-foreground" />
                        Preview
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setEditingTemplate(tpl)}
                        className="cursor-pointer hover:bg-muted focus:bg-muted"
                      >
                        <Pencil className="h-4 w-4 mr-2 text-muted-foreground" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleDuplicate(tpl)}
                        disabled={duplicatingId === tpl.id}
                        className="cursor-pointer hover:bg-muted focus:bg-muted"
                      >
                        <Copy className="h-4 w-4 mr-2 text-muted-foreground" />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDeletingTemplate(tpl)}
                        className="cursor-pointer text-destructive focus:text-destructive hover:bg-muted focus:bg-muted"
                      >
                        <Trash2 className="h-4 w-4 mr-2 text-destructive" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                  {tpl.description || 'No description'}
                </p>

                <p className="text-[11px] text-muted-foreground truncate" data-testid="insight-template-card-meta">
                  {tpl.created_by_name ? `by ${tpl.created_by_name} · ` : ''}
                  updated {formatTemplateDate(tpl.updated_at)}
                </p>

                {formatTemplateUsage(tpl.usage_count) && (
                  <p className="text-[11px] text-muted-foreground" data-testid="insight-template-card-usage">
                    {formatTemplateUsage(tpl.usage_count)}
                  </p>
                )}

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUseTemplate?.({ id: tpl.id, name: tpl.name });
                  }}
                  onKeyDown={stopPropagation}
                  className="mt-auto w-full"
                >
                  Use Template
                </Button>
              </div>
              </HtmlHoverPreview>
            );
          })}
        </div>
      )}

      {showDeleted && (
        <section
          className="rounded-xl border border-border bg-card p-4 space-y-3"
          aria-labelledby="recently-deleted-heading"
          data-testid="template-recently-deleted"
        >
          <div>
            <h3 id="recently-deleted-heading" className="text-sm font-semibold text-foreground">
              Recently deleted
            </h3>
            <p className="text-xs text-muted-foreground">
              Restore a template to bring it back to the library, or delete it forever.
            </p>
          </div>
          {deletedLoading && deletedTemplates.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading...
            </div>
          ) : deletedTemplates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No recently deleted templates.</p>
          ) : (
            <ul className="space-y-2">
              {deletedTemplates.map((tpl) => (
                <li
                  key={tpl.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted p-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{tpl.name}</div>
                    {tpl.deleted_at && (
                      <div className="text-xs text-muted-foreground">
                        Deleted {formatTemplateDate(tpl.deleted_at)}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 bg-card text-foreground border-border hover:bg-muted text-xs"
                      disabled={restoringId === tpl.id}
                      onClick={() => handleRestore(tpl)}
                    >
                      {restoringId === tpl.id ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArchiveRestore className="h-3.5 w-3.5 mr-1" />
                      )}
                      Restore
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 bg-card text-destructive border-border hover:bg-muted text-xs"
                      onClick={() => setPurgingTemplate(tpl)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Delete forever
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <InsightTemplateUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={fetchTemplates}
      />

      <InsightTemplateEditDialog
        template={editingTemplate}
        open={Boolean(editingTemplate)}
        onOpenChange={(open) => {
          if (!open) setEditingTemplate(null);
        }}
        onSaved={fetchTemplates}
      />

      <InsightTemplatePreviewDialog target={preview} onClose={() => setPreview(null)} />

      <AlertDialog
        open={Boolean(deletingTemplate)}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeletingTemplate(null);
        }}
      >
        <AlertDialogContent className="bg-card text-card-foreground border border-border sm:max-w-md p-6 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold">
              Delete Template
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              Delete &ldquo;{deletingTemplate?.name}&rdquo;? You can restore it from
              Recently deleted.
              {formatTemplateUsage(deletingTemplate?.usage_count) && (
                <span className="block mt-2" data-testid="template-delete-usage">
                  {formatTemplateUsage(deletingTemplate?.usage_count)}.{' '}
                  {deletingTemplate?.usage_count === 1
                    ? 'It keeps its content.'
                    : 'They keep their content.'}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0 pt-2">
            <AlertDialogCancel
              disabled={isDeleting}
              className="bg-card text-foreground border-border hover:bg-muted"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(purgingTemplate)}
        onOpenChange={(open) => {
          if (!open && !isPurging) setPurgingTemplate(null);
        }}
      >
        <AlertDialogContent className="bg-card text-card-foreground border border-border sm:max-w-md p-6 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold">
              Delete Forever
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground">
              Permanently delete &ldquo;{purgingTemplate?.name}&rdquo; and its version
              history? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0 pt-2">
            <AlertDialogCancel
              disabled={isPurging}
              className="bg-card text-foreground border-border hover:bg-muted"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handlePurge();
              }}
              disabled={isPurging}
              className="bg-destructive text-destructive-foreground hover:bg-destructive"
            >
              {isPurging ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                'Delete forever'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
