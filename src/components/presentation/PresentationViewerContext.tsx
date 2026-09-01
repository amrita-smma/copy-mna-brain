'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, FileText } from 'lucide-react';
import FileBody from '@/components/Files/FileBody';
import { detectFileKind } from '@/lib/fileType';

export interface PresentationFile {
  /** Stable S3 key (preferred — re-signs on demand, recorded as recently-opened). */
  key?: string;
  /** Pre-signed URL fallback when no key is available. */
  url?: string;
  name: string;
}

export type PresentationKind = 'pdf' | 'pptx' | 'other';

export function fileKind(name: string): PresentationKind {
  const kind = detectFileKind(name);
  if (kind === 'pdf') return 'pdf';
  if (kind === 'pptx') return 'pptx';
  return 'other';
}

interface PresentationViewerContextValue {
  hydrated: boolean;
  currentFile: PresentationFile | null;
  signedUrl: string | null;
  downloadUrl: string | null;
  loading: boolean;
  error: string | null;
  openFile: (file: PresentationFile) => void;
  clearFile: () => void;
  /** Registers the in-page placeholder the persistent viewer should overlay. */
  registerViewport: (el: HTMLElement | null) => void;
  requestFullscreen: () => void;
}

const PresentationViewerContext = createContext<PresentationViewerContextValue | null>(null);

export function usePresentationViewer(): PresentationViewerContextValue {
  const value = useContext(PresentationViewerContext);
  if (!value) {
    throw new Error('usePresentationViewer must be used within a PresentationViewerProvider');
  }
  return value;
}

const LAST_FILE_KEY = 'presentation:last-file';

function sameFile(a: PresentationFile | null, b: PresentationFile): boolean {
  if (!a) return false;
  if (a.name !== b.name) return false;
  if (b.key) return a.key === b.key;
  if (b.url) return a.url === b.url;
  return false;
}

function fileIdentity(file: PresentationFile | null): string | null {
  if (!file) return null;
  return `${file.key ?? file.url ?? ''}::${file.name}`;
}

/**
 * Keeps the Presentation file viewer mounted for the whole session so it never
 * reloads when the user navigates between tabs.
 *
 * An iframe (used for pptx) is destroyed and reloaded whenever it is unmounted
 * or reparented in the DOM (a browser limitation, not a React one), and the
 * PDF viewer would likewise lose its component state (current page, zoom) on
 * unmount, so we cannot rely on portals or per-route mounting. Instead the
 * viewer lives in a single fixed overlay rendered above the router, and the
 * `/presentation` page registers a placeholder element that the overlay is
 * positioned over. Leaving the page just hides the overlay with CSS;
 * returning re-reveals the very same viewer with its live state intact.
 */
export function PresentationViewerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onPresentation =
    pathname === '/presentation' ||
    pathname.startsWith('/presentation/') ||
    pathname.endsWith('/presentation') ||
    pathname.includes('/presentation/');

  const [hydrated, setHydrated] = useState(false);
  const [currentFile, setCurrentFile] = useState<PresentationFile | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  // Tracks which file identity we've already resolved a signed URL for, so the
  // viewer doesn't re-sign (and reload the iframe) on every navigation back.
  const signedForId = useRef<string | null>(null);

  // Restore the last-opened file after a full page refresh.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_FILE_KEY);
      if (raw) setCurrentFile(JSON.parse(raw) as PresentationFile);
    } catch {
      // ignore malformed persisted state
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (currentFile) localStorage.setItem(LAST_FILE_KEY, JSON.stringify(currentFile));
      else localStorage.removeItem(LAST_FILE_KEY);
    } catch {
      // storage may be unavailable; the in-memory state still works
    }
  }, [currentFile, hydrated]);

  const openFile = useCallback((file: PresentationFile) => {
    setCurrentFile((prev) => (sameFile(prev, file) ? prev : file));
  }, []);

  const clearFile = useCallback(() => setCurrentFile(null), []);

  const registerViewport = useCallback((el: HTMLElement | null) => setViewport(el), []);

  const requestFullscreen = useCallback(() => {
    overlayRef.current?.requestFullscreen?.();
  }, []);

  const fileId = fileIdentity(currentFile);

  // Resolve a fresh signed URL the first time a file is shown on the
  // presentation page. Deferring until then avoids pointless (unauthorized)
  // calls on other routes, and the once-per-file guard keeps the iframe stable.
  useEffect(() => {
    if (!currentFile) {
      signedForId.current = null;
      setSignedUrl(null);
      setDownloadUrl(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!onPresentation) return;
    if (signedForId.current === fileId) return;
    signedForId.current = fileId;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSignedUrl(null);
    setDownloadUrl(null);

    const run = async () => {
      try {
        let resolved = currentFile.url ?? null;
        let download = currentFile.url ?? null;
        if (currentFile.key) {
          const res = await fetch(
            `/api/recent-files/signed-url?key=${encodeURIComponent(currentFile.key)}&name=${encodeURIComponent(currentFile.name)}`,
          );
          const payload = await res.json();
          if (!res.ok) throw new Error(payload?.error || 'Failed to load file');
          resolved = payload.data.url as string;
          download = payload.data.downloadUrl as string;
          // Record the open so it surfaces in the recently-opened list.
          fetch('/api/recent-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: currentFile.name, fileKey: currentFile.key }),
          }).catch(() => {});
        }
        if (!cancelled) {
          setSignedUrl(resolved);
          setDownloadUrl(download);
        }
      } catch (err) {
        if (!cancelled) {
          signedForId.current = null; // allow a retry on next visit
          setError((err as Error).message || 'Failed to load file');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [currentFile, fileId, onPresentation]);

  const visible = onPresentation && !!currentFile && !!viewport;

  // Keep the fixed overlay aligned with the in-page placeholder. A rAF loop
  // tracks the placeholder through sidebar/copilot layout animations.
  useEffect(() => {
    if (!visible || !viewport) return;
    let raf = 0;
    const update = () => {
      const overlay = overlayRef.current;
      if (overlay) {
        const rect = viewport.getBoundingClientRect();
        overlay.style.top = `${rect.top}px`;
        overlay.style.left = `${rect.left}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
      }
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [visible, viewport]);

  // Triggers a same-tab download via a throwaway anchor — mirrors what a
  // plain `<a download>` does, but as an on-demand action so it can be
  // FileBody's shared "Download instead" / "Download File" button.
  const triggerDownload = useCallback(async () => {
    const href = downloadUrl || signedUrl;
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    if (currentFile?.name) link.download = currentFile.name;
    link.rel = 'noreferrer';
    link.click();
  }, [downloadUrl, signedUrl, currentFile?.name]);

  return (
    <PresentationViewerContext.Provider
      value={{
        hydrated,
        currentFile,
        signedUrl,
        downloadUrl,
        loading,
        error,
        openFile,
        clearFile,
        registerViewport,
        requestFullscreen,
      }}
    >
      {children}
      <div
        ref={overlayRef}
        className="fixed z-30 overflow-hidden bg-muted/20"
        style={{ display: visible ? 'block' : 'none' }}
        aria-hidden={!visible}
      >
        {loading ? (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <FileText className="h-10 w-10 opacity-50" />
            <p>{error}</p>
          </div>
        ) : signedUrl ? (
          <FileBody url={signedUrl} fileName={currentFile?.name || ''} onDownload={triggerDownload} />
        ) : null}
      </div>
    </PresentationViewerContext.Provider>
  );
}
