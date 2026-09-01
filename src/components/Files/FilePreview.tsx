'use client';

import { useRouter } from 'next/navigation';
import { Presentation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';
import FileBody from '@/components/Files/FileBody';

interface FilePreviewProps {
  url: string;
  onDownload?: () => Promise<void>;
  fileName: string;
  /**
   * S3 key for the file. When provided, the full-screen button opens the file
   * in the Presentation page (and records it as recently-opened). Without it,
   * the full-screen button falls back to passing the signed URL through.
   */
  fileKey?: string;
}

export default function FilePreview({ url, onDownload, fileName, fileKey }: FilePreviewProps) {
  const router = useRouter();
  const presentationHref = useWorkspaceHref('/presentation');

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

  return (
    <div className="flex h-full w-full min-h-[300px] flex-col">
      <div className="flex flex-shrink-0 items-center justify-end border-b bg-background px-2 py-1.5">
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
      </div>
      <div className="min-h-0 flex-1">
        <FileBody url={url} fileName={fileName} onDownload={onDownload} />
      </div>
    </div>
  );
}
