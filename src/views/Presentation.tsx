"use client";

import { Button } from "@/components/ui/button";
import {
  Loader2,
  FileText,
  ArrowLeft,
  Download,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Clock,
  Maximize2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { usePresentationViewer } from "@/components/presentation/PresentationViewerContext";
import { PageHeader } from "@/components/layout/PageHeader";
import { PresentationFileSearch } from "@/components/presentation/PresentationFileSearch";
import { detectFileKind, isPresentableFileKind } from "@/lib/fileType";
import { isYouTubeVideoUrl } from "@/lib/media/youtube";
import FileKindIcon from "@/components/Files/FileKindIcon";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";

interface RecentFileItem {
  id: string;
  file_name: string;
  file_key: string;
  opened_at: string | null;
}

const PAGE_SIZE = 10;

export default function Presentation() {
  const router = useRouter();
  const presentationHref = useWorkspaceHref("/presentation");
  const searchParams = useSearchParams();
  const key = searchParams.get("key");
  const urlParam = searchParams.get("url");
  const name = searchParams.get("name") ?? "";

  // The viewer itself (signed URL + iframe) lives in a session-persistent host
  // so it never reloads when switching tabs. This page only drives selection
  // and renders the surrounding chrome + a placeholder for the iframe.
  const {
    hydrated,
    currentFile,
    signedUrl,
    downloadUrl,
    loading: viewerLoading,
    error: viewerError,
    openFile,
    clearFile,
    registerViewport,
    requestFullscreen,
  } = usePresentationViewer();

  // Apply a URL-based selection (deep links, "open in presentation" buttons).
  // With no params we keep whatever file is already open, so returning to the
  // tab via the sidebar restores the live viewer instead of resetting it.
  useEffect(() => {
    if (key) openFile({ key, name });
    else if (urlParam) openFile({ url: urlParam, name });
  }, [key, urlParam, name, openFile]);

  // Recent list state (when nothing is selected).
  const [recent, setRecent] = useState<RecentFileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);

  const hasParamSelection = !!(key || urlParam);
  const showViewer = !!currentFile || hasParamSelection;

  const loadRecent = useCallback(async (p: number) => {
    setListLoading(true);
    try {
      const res = await fetch(`/api/recent-files?page=${p}`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to load recent files");
      setRecent(payload.data.items as RecentFileItem[]);
      setTotal(payload.data.total as number);
      setPage(payload.data.page as number);
    } catch {
      setRecent([]);
      setTotal(0);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hydrated && !showViewer) loadRecent(page);
  }, [hydrated, showViewer, page, loadRecent]);

  const openRecent = (item: RecentFileItem) => {
    openFile({ key: item.file_key, name: item.file_name });
    const params = new URLSearchParams({ key: item.file_key, name: item.file_name });
    router.replace(`${presentationHref}?${params.toString()}`);
  };

  const openSearchResult = (file: { fileKey: string; fileName: string }) => {
    openFile({ key: file.fileKey, name: file.fileName });
    const params = new URLSearchParams({ key: file.fileKey, name: file.fileName });
    router.replace(`${presentationHref}?${params.toString()}`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Clear the persisted file before showing the list, otherwise it would
  // immediately reopen on the next render.
  const goToRecent = () => {
    clearFile();
    router.replace(presentationHref);
  };

  // While the persisted selection is still hydrating, avoid flashing the recent
  // list (the viewer is about to render).
  if (!hydrated) {
    return (
      <>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // File viewer
  // ---------------------------------------------------------------------------
  if (showViewer) {
    const displayName = currentFile?.name ?? name;
    const isYouTube = isYouTubeVideoUrl(signedUrl);
    // Fullscreen is available for any kind FileBody can actually render, not
    // just pdf/pptx — matches what the search picker offers as "presentable".
    // A YouTube link has no extension to detect, so it is checked by URL.
    const canFullscreen =
      !!signedUrl && (isYouTube || isPresentableFileKind(detectFileKind(displayName)));

    return (
      <>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" size="sm" onClick={goToRecent} className="gap-1.5">
                <ArrowLeft className="h-4 w-4" />
                Recent files
              </Button>
              <div className="flex min-w-0 items-center gap-2">
                <FileKindIcon fileName={displayName} youtube={isYouTube} />
                <span className="truncate text-sm font-medium">{displayName || "File"}</span>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <PresentationFileSearch onSelect={openSearchResult} className="ml-auto max-w-sm" />
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {canFullscreen && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={requestFullscreen}>
                  <Maximize2 className="h-4 w-4" />
                  Fullscreen
                </Button>
              )}
              {(downloadUrl || signedUrl) && (
                <a
                  href={(downloadUrl || signedUrl) as string}
                  target="_blank"
                  rel="noreferrer"
                  download={isYouTube ? undefined : displayName || undefined}
                >
                  {/* A YouTube link has no file behind it — offer the video page instead. */}
                  <Button variant="outline" size="sm" className="gap-1.5">
                    {isYouTube ? <ExternalLink className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                    {isYouTube ? "Open on YouTube" : "Download"}
                  </Button>
                </a>
              )}
            </div>
          </div>

          {/*
            Placeholder the persistent viewer host overlays. The iframe itself
            is rendered once at the app root so it survives tab switches; here we
            only reserve the space. A local loader covers the brief window before
            the host's signed URL resolves.
          */}
          <div ref={registerViewport} className="relative min-h-0 flex-1 bg-muted/20">
            {viewerLoading && (
              <div className="flex h-full w-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            )}
            {viewerError && !viewerLoading && (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <FileText className="h-10 w-10 opacity-50" />
                <p>{viewerError}</p>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Recently-opened list
  // ---------------------------------------------------------------------------
  return (
    <>
      <div className="min-h-full">
        <PageHeader
          title="Presentation"
          subtitle="Recently opened files. Select one to display it full screen."
          innerClassName="mx-auto w-full max-w-3xl"
        />

        <div className="mx-auto w-full max-w-3xl p-6">
        <PresentationFileSearch onSelect={openSearchResult} className="mb-6" />

        {listLoading ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : recent.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-muted-foreground">
            <FileText className="h-10 w-10 opacity-50" />
            <div className="text-center">
              <p className="font-medium">No recently-opened files</p>
              <p className="text-sm">
                Open a file from anywhere and use its full-screen button to view it here.
              </p>
            </div>
          </div>
        ) : (
          <>
            <ul className="divide-y rounded-lg border">
              {recent.map((item) => {
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => openRecent(item)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <FileKindIcon fileName={item.file_name} className="h-5 w-5" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {item.file_name}
                      </span>
                      {item.opened_at && (
                        <span className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(item.opened_at), { addSuffix: true })}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="gap-1"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="gap-1"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </>
  );
}
