'use client';

import { useId, useState } from 'react';
import { Loader2, Presentation, Trash2, Upload, Youtube } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { FEATURED_SLIDE_ACCEPT } from '@/lib/fileType';
import { CollapsibleSection } from '@/components/pipeline/CollapsibleSection';
import ExistingAttachmentPicker from '@/components/pipeline/ExistingAttachmentPicker';
import FeaturedSlideViewer from './FeaturedSlideViewer';
import type { FeaturedSlideController } from './useFeaturedSlide';

/**
 * The Additional Context tab's Featured Slide section, rendered by both
 * `CompanyDetailDialog` and the `CompanyDetail` page from one
 * `useFeaturedSlide` controller. A featured slide is a PDF / PPTX deck, a
 * video or audio recording, or a YouTube video.
 *
 * Collapsed by default: the viewer is 70vh tall, and the documents it reads
 * land after this first renders, so an `open` derived from them would pop the
 * section open mid-read. The current slide's name goes in the header instead.
 */
export default function FeaturedSlideSection({ featured }: { featured: FeaturedSlideController }) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const [showYouTubeForm, setShowYouTubeForm] = useState(false);
  const [youTubeUrl, setYouTubeUrl] = useState('');
  const [youTubeTitle, setYouTubeTitle] = useState('');

  const { slide, options, selectedOptionId, busy, uploading } = featured;
  const item = slide.item;

  const onFileChosen = (file: File | undefined) => {
    if (file && !busy) void featured.upload(file);
  };

  const submitYouTube = async () => {
    const ok = await featured.addYouTubeLink(youTubeUrl, youTubeTitle);
    if (ok) {
      setYouTubeUrl('');
      setYouTubeTitle('');
      setShowYouTubeForm(false);
    }
  };

  return (
    <CollapsibleSection
      title="Featured Slide"
      description={
        item
          ? `Currently featuring ${item.name}.`
          : 'Highlight a company one-pager (PDF or PPTX), a video or audio recording, or a YouTube video full-width on this card.'
      }
      icon={<Presentation className="h-4 w-4" />}
      defaultOpen={false}
    >
      <div
        className={cn('space-y-3 rounded-lg transition-shadow', dragging && 'ring-2 ring-primary ring-offset-2')}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFileChosen(e.dataTransfer.files?.[0]);
        }}
        data-testid="featured-slide-section"
      >
        <div className="flex items-center justify-end gap-1 flex-wrap">
          {options.length > 0 && (
            <ExistingAttachmentPicker
              documents={options}
              onSelect={(id) => void featured.selectExisting(id)}
              selectedId={selectedOptionId}
              disabled={busy}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busy}
            onClick={() => setShowYouTubeForm((prev) => !prev)}
            data-testid="featured-slide-youtube-toggle"
          >
            <Youtube className="h-3.5 w-3.5" />
            YouTube link
          </Button>
          <Label htmlFor={inputId} className="cursor-pointer">
            <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} asChild>
              <span>
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {item ? 'Replace' : 'Upload'}
              </span>
            </Button>
          </Label>
          {item && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void featured.remove()}
              disabled={busy}
              title="Remove featured slide"
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          )}
        </div>

        {showYouTubeForm && (
          <form
            className="flex flex-col gap-2 rounded-lg border bg-muted p-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void submitYouTube();
            }}
          >
            <Input
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={youTubeUrl}
              onChange={(e) => setYouTubeUrl(e.target.value)}
              className="bg-card sm:flex-[2]"
              aria-label="YouTube link"
              autoFocus
            />
            <Input
              placeholder="Title (optional)"
              value={youTubeTitle}
              onChange={(e) => setYouTubeTitle(e.target.value)}
              className="bg-card sm:flex-1"
              aria-label="YouTube link title"
            />
            <Button type="submit" size="sm" className="sm:self-center" disabled={busy || !youTubeUrl.trim()}>
              Feature
            </Button>
          </form>
        )}

        <Input
          id={inputId}
          type="file"
          accept={FEATURED_SLIDE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            onFileChosen(file);
          }}
          disabled={busy}
        />

        {item ? (
          <div className="h-[70vh] w-full">
            <FeaturedSlideViewer slide={slide} empty={null} />
          </div>
        ) : (
          <div>
            <Label htmlFor={inputId} className="cursor-pointer">
              <div
                className={cn(
                  'border-2 border-dashed rounded-lg bg-muted p-10 text-center transition-colors',
                  dragging ? 'border-primary bg-primary/5' : 'hover:border-primary',
                )}
              >
                <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Click to upload, or drag and drop a PDF, PPTX, video or audio file to feature it here — or add a
                  YouTube link above
                </p>
              </div>
            </Label>
            {uploading && (
              <div className="flex items-center justify-center gap-2 mt-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Uploading…
              </div>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
