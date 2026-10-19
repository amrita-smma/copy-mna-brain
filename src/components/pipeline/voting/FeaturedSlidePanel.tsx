'use client';

import { Download, Loader2, Presentation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import FilePreview from '@/components/Files/FilePreview';

/**
 * The company's Featured Slide as the voting tab sees it. Both company surfaces
 * (`CompanyDetailDialog` and the `CompanyDetail` page) already resolve the
 * featured document and its signed preview URL for their Overview section, so
 * they hand that same state down rather than the tab fetching it again.
 */
export interface FeaturedSlideState {
  document: { id: string; file_name: string; file_path: string } | null;
  /** Signed preview URL; null while loading or when no preview is available. */
  url: string | null;
  loading: boolean;
  onDownload: () => Promise<void> | void;
}

/** The featured slide, previewed beside the vote so voters can read the deal. */
export default function FeaturedSlidePanel({
  slide,
  className,
}: {
  slide: FeaturedSlideState | undefined;
  className?: string;
}) {
  const title = (
    <>
      <Presentation className="h-4 w-4 shrink-0" />
      <span className="truncate">
        {slide?.document ? slide.document.file_name : 'Featured slide'}
      </span>
    </>
  );

  return (
    <div
      className={cn('flex flex-col overflow-hidden rounded-lg border bg-card', className)}
      data-testid="voting-featured-slide"
    >
      {slide?.document && slide.url && !slide.loading ? (
        <FilePreview
          title={title}
          url={slide.url}
          fileName={slide.document.file_name}
          fileKey={slide.document.file_path}
          onDownload={slide.onDownload}
        />
      ) : (
        <>
          <div className="flex flex-shrink-0 items-center border-b bg-background px-2 py-2.5">
            <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">{title}</h3>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted p-6 text-center text-sm text-muted-foreground">
            {slide?.loading ? (
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            ) : slide?.document ? (
              <>
                <p>Preview not available</p>
                <Button variant="outline" size="sm" onClick={() => void slide.onDownload()}>
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </Button>
              </>
            ) : (
              'No featured slide yet — feature a PDF or PPTX from the Overview tab to show it here.'
            )}
          </div>
        </>
      )}
    </div>
  );
}
