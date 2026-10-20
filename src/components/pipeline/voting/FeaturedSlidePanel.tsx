'use client';

import { Presentation } from 'lucide-react';
import { cn } from '@/lib/utils';
import FileKindIcon from '@/components/Files/FileKindIcon';
import FeaturedSlideViewer from '@/components/pipeline/featured/FeaturedSlideViewer';
import type { FeaturedSlideState } from '@/components/pipeline/featured/useFeaturedSlide';

/**
 * The company's Featured Slide as the voting tab sees it. Both company surfaces
 * (`CompanyDetailDialog` and the `CompanyDetail` page) already resolve the
 * featured item and its preview URL through `useFeaturedSlide`, so they hand
 * that same state down rather than the tab fetching it again.
 */
export type { FeaturedSlideState };

/** The featured slide, previewed beside the vote so voters can read the deal. */
export default function FeaturedSlidePanel({
  slide,
  className,
}: {
  slide: FeaturedSlideState | undefined;
  className?: string;
}) {
  const item = slide?.item ?? null;
  const title = (
    <>
      {item ? (
        <FileKindIcon fileName={item.kind === 'document' ? item.name : undefined} youtube={item.kind === 'link'} />
      ) : (
        <Presentation className="h-4 w-4 shrink-0" />
      )}
      <span className="truncate">{item ? item.name : 'Featured slide'}</span>
    </>
  );

  return (
    <div
      className={cn('flex flex-col overflow-hidden rounded-lg border bg-card', className)}
      data-testid="voting-featured-slide"
    >
      {item && slide?.url ? (
        <FeaturedSlideViewer slide={slide} title={title} empty={null} />
      ) : (
        <>
          <div className="flex flex-shrink-0 items-center border-b bg-background px-2 py-2.5">
            <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">{title}</h3>
          </div>
          <div className="flex flex-1 flex-col">
            <FeaturedSlideViewer
              slide={slide}
              empty={
                <div className="flex flex-1 items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
                  No featured slide yet — feature a PDF, PPTX, recording or YouTube video from the Additional Context
                  tab to show it here.
                </div>
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
