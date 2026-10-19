'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Loader2, Presentation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import FileBody from '@/components/Files/FileBody';

interface FilePreviewProps {
  url: string;
  /**
   * Downloads the original file. Every file preview offers a download: the
   * toolbar always shows a Download button next to Present, and without this
   * handler it falls back to downloading the previewed `url` itself.
   */
  onDownload?: () => Promise<void> | void;
  fileName: string;
  /**
   * S3 key for the file. When provided, the full-screen button opens the file
   * in the Presentation page (and records it as recently-opened). Without it,
   * the full-screen button falls back to passing the signed URL through.
   */
  fileKey?: string;
  /**
   * Optional heading rendered to the left of the toolbar buttons, in the same
   * toolbar row — lets callers fold a "File Preview" label into this
   * component's own header instead of stacking a separate heading above it.
   */
  title?: ReactNode;
}

/**
 * A file preview with its toolbar: Present (open in the Presentation tab) and
 * Download. Use this — not a bare `FileBody` — wherever a file is previewed,
 * so a preview is never shown without a way to download the file.
 */
export default function FilePreview({ url, onDownload, fileName, fileKey, title }: FilePreviewProps) {
  const router = useRouter();
  const presentationHref = useWorkspaceHref('/presentation');
  const [downloading, setDownloading] = useState(false);

  // Open the file by itself in the Presentation page. Prefer the stable S3
  // key (re-openable + recorded as recently-opened); fall back to the signed
  // URL when no key is available.
  const openInPresentation = () => {
    const params = new URLSearchParams();
    if (fileKey) {
      params.set('key', fileKey);
    } else {
      params.set('url', url);
    }
    params.set('name', fileName);
    router.push(`${presentationHref}?${params.toString()}`);
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      if (onDownload) {
        await onDownload();
      } else {
        downloadFromUrl(url, fileName);
      }
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex h-full w-full min-h-[300px] flex-col">
      <div
        className={`flex flex-shrink-0 items-center border-b bg-background px-2 py-1.5 ${title ? 'justify-between gap-2' : 'justify-end'}`}
      >
        {title ? (
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">{title}</h3>
        ) : null}
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={openInPresentation}
            title="Open in the Presentation tab"
            className="gap-1.5"
          >
            <Presentation className="h-4 w-4" />
            Present
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleDownload()}
            disabled={downloading}
            title={`Download ${fileName}`}
            className="gap-1.5"
            data-testid="file-preview-download"
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <FileBody url={url} fileName={fileName} onDownload={handleDownload} />
      </div>
    </div>
  );
}

/** Fallback download for callers without a dedicated download endpoint. */
function downloadFromUrl(url: string, fileName: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener noreferrer';
  a.target = '_blank';
  a.click();
}
