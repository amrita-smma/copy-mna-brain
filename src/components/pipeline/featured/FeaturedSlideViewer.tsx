'use client';

import type { ReactNode } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import FilePreview from '@/components/Files/FilePreview';
import type { FeaturedSlideState } from './useFeaturedSlide';

/**
 * The featured slide itself — a deck, a recording or a YouTube video — in a
 * `FilePreview` with its Present / Download (or Open on YouTube) toolbar.
 * Shared by the Additional Context section and the Voting tab so both play
 * every featurable kind the same way. Renders `empty` when nothing is featured.
 */
export default function FeaturedSlideViewer({
  slide,
  title,
  empty,
}: {
  slide: FeaturedSlideState | undefined;
  /** Folded into the preview toolbar's left side. */
  title?: ReactNode;
  empty: ReactNode;
}) {
  const item = slide?.item ?? null;

  if (!slide || !item) return <>{empty}</>;

  if (slide.url) {
    return (
      <FilePreview
        title={title}
        url={slide.url}
        fileName={item.name}
        fileKey={item.kind === 'document' ? item.filePath : undefined}
        onDownload={slide.onDownload}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-md border bg-muted p-6 text-center text-sm text-muted-foreground">
      {slide.loading ? (
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      ) : (
        <>
          <p>Preview not available</p>
          <Button variant="outline" size="sm" onClick={() => void slide.onDownload()}>
            <Download className="h-4 w-4 mr-2" />
            Download
          </Button>
        </>
      )}
    </div>
  );
}
