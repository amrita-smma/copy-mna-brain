"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  FileText,
  FileType2,
  ArrowLeft,
  Download,
  ChevronLeft,
  ChevronRight,
  Presentation as PresentationIcon,
  Clock,
  Maximize2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useLocalStorage } from "@/hooks/useLocalStorage";

interface PresentationProps {
  showCompanyGraph?: boolean;
}

interface StoredFile {
  key: string;
  name: string;
}

const LAST_FILE_KEY = "presentation:last-file";

interface RecentFileItem {
  id: string;
  file_name: string;
  file_key: string;
  opened_at: string | null;
}

const PAGE_SIZE = 10;

function fileKind(name: string): "pdf" | "pptx" | "other" {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "pptx" || ext === "ppt") return "pptx";
  return "other";
}

export default function Presentation({ showCompanyGraph = false }: PresentationProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const key = searchParams.get("key");
  const urlParam = searchParams.get("url");
  const name = searchParams.get("name") ?? "";
  const hasSelection = !!(key || urlParam);

  // Persist the open file so returning to the Presentation tab (e.g. via the
  // sidebar, which navigates to /presentation with no query params) reopens it
  // instead of dropping back to the recent list.
  const [lastFile, setLastFile] = useLocalStorage<StoredFile | null>(LAST_FILE_KEY, null);

  // Remember key-based selections (they re-sign fresh on reopen).
  useEffect(() => {
    if (key) setLastFile({ key, name });
  }, [key, name, setLastFile]);

  // With no file selected, restore the last-opened one if we have it.
  const restoring = !hasSelection && !!lastFile?.key;
  useEffect(() => {
    if (hasSelection || !lastFile?.key) return;
    const params = new URLSearchParams({ key: lastFile.key, name: lastFile.name });
    router.replace(`/presentation?${params.toString()}`);
  }, [hasSelection, lastFile, router]);

  // Viewer state (when a file is selected).
  const viewerRef = useRef<HTMLDivElement>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);

  // Recent list state (when nothing is selected).
  const [recent, setRecent] = useState<RecentFileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(true);

  // Resolve a fresh signed URL for the selected file and record the open.
  useEffect(() => {
    if (!hasSelection) return;
    let cancelled = false;
    setViewerLoading(true);
    setViewerError(null);
    setSignedUrl(null);
    setDownloadUrl(null);

    const run = async () => {
      try {
        let resolved = urlParam;
        let download = urlParam;
        if (key) {
          const res = await fetch(
            `/api/recent-files/signed-url?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`,
          );
          const payload = await res.json();
          if (!res.ok) throw new Error(payload?.error || "Failed to load file");
          resolved = payload.data.url as string;
          download = payload.data.downloadUrl as string;
          // Record the open so it surfaces in the recently-opened list.
          fetch("/api/recent-files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileName: name, fileKey: key }),
          }).catch(() => {});
        }
        if (!cancelled) {
          setSignedUrl(resolved);
          setDownloadUrl(download);
        }
      } catch (err) {
        if (!cancelled) setViewerError((err as Error).message || "Failed to load file");
      } finally {
        if (!cancelled) setViewerLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [hasSelection, key, urlParam, name]);

  // Load the paginated recent-files list when no file is selected.
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
    if (!hasSelection && !restoring) loadRecent(page);
  }, [hasSelection, restoring, page, loadRecent]);

  const openFile = (item: RecentFileItem) => {
    const params = new URLSearchParams({ key: item.file_key, name: item.file_name });
    router.push(`/presentation?${params.toString()}`);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const enterFullscreen = () => {
    viewerRef.current?.requestFullscreen?.();
  };

  // Clear the persisted file before showing the list, otherwise the restore
  // effect would immediately reopen it.
  const goToRecent = () => {
    setLastFile(null);
    router.push("/presentation");
  };

  // ---------------------------------------------------------------------------
  // File viewer
  // ---------------------------------------------------------------------------
  if (hasSelection) {
    const kind = fileKind(name);
    const canFullscreen = !!signedUrl && (kind === "pdf" || kind === "pptx");

    return (
      <DashboardLayout showCompanyGraph={showCompanyGraph}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={goToRecent}
                className="gap-1.5"
              >
                <ArrowLeft className="h-4 w-4" />
                Recent files
              </Button>
              <div className="flex min-w-0 items-center gap-2">
                {kind === "pptx" ? (
                  <PresentationIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="truncate text-sm font-medium">{name || "File"}</span>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {canFullscreen && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={enterFullscreen}>
                  <Maximize2 className="h-4 w-4" />
                  Fullscreen
                </Button>
              )}
              {(downloadUrl || signedUrl) && (
                <a
                  href={(downloadUrl || signedUrl) as string}
                  target="_blank"
                  rel="noreferrer"
                  download={name || undefined}
                >
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <Download className="h-4 w-4" />
                    Download
                  </Button>
                </a>
              )}
            </div>
          </div>

          <div ref={viewerRef} className="min-h-0 flex-1 bg-muted/20">
            {viewerLoading ? (
              <div className="flex h-full w-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : viewerError ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <FileText className="h-10 w-10 opacity-50" />
                <p>{viewerError}</p>
              </div>
            ) : signedUrl && kind === "pdf" ? (
              <iframe src={signedUrl} className="h-full w-full" title={name || "PDF"} />
            ) : signedUrl && kind === "pptx" ? (
              <iframe
                src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(signedUrl)}`}
                className="h-full w-full"
                title={name || "Presentation"}
              />
            ) : signedUrl ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-4 text-muted-foreground">
                <FileType2 className="h-12 w-12 opacity-50" />
                <div className="text-center">
                  <p className="font-medium text-foreground">Preview not supported</p>
                  <p className="text-sm">Only PDF and PPTX files can be displayed here.</p>
                </div>
                <a
                  href={(downloadUrl || signedUrl) as string}
                  target="_blank"
                  rel="noreferrer"
                  download={name || undefined}
                >
                  <Button variant="outline" className="gap-1.5">
                    <Download className="h-4 w-4" />
                    Download file
                  </Button>
                </a>
              </div>
            ) : null}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  // While restoring the persisted file, show a loader instead of flashing the
  // recent list (the redirect effect is about to swap in the viewer).
  if (restoring) {
    return (
      <DashboardLayout showCompanyGraph={showCompanyGraph}>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  // ---------------------------------------------------------------------------
  // Recently-opened list
  // ---------------------------------------------------------------------------
  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      <div className="mx-auto w-full max-w-3xl p-6">
        <div className="mb-6 flex items-center gap-3">
          <PresentationIcon className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Presentation</h1>
            <p className="text-sm text-muted-foreground">
              Recently opened files. Select one to display it full screen.
            </p>
          </div>
        </div>

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
                const kind = fileKind(item.file_name);
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => openFile(item)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                    >
                      {kind === "pptx" ? (
                        <PresentationIcon className="h-5 w-5 flex-shrink-0 text-orange-500" />
                      ) : kind === "pdf" ? (
                        <FileText className="h-5 w-5 flex-shrink-0 text-red-500" />
                      ) : (
                        <FileType2 className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
                      )}
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
    </DashboardLayout>
  );
}
