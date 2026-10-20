import { detectFileKind, isFeaturableFileKind } from '@/lib/fileType';
import { isYouTubeVideoUrl } from '@/lib/media/youtube';

/**
 * A company's Featured Slide is one item: an uploaded deck or recording
 * (`deal_documents.is_featured`) or a YouTube link (`deal_links.is_featured`).
 * `DealDocumentService` and `DealLinkService` each clear both tables' flags
 * before setting their own, so the two never both hold one for a deal.
 */
export class UnsupportedFeaturedSlideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFeaturedSlideError';
  }
}

export function assertFeaturableFile(fileName: string): void {
  if (!isFeaturableFileKind(detectFileKind(fileName))) {
    throw new UnsupportedFeaturedSlideError(
      'Only PDF, PPTX, video or audio files can be featured',
    );
  }
}

export function assertFeaturableLink(url: string): void {
  if (!isYouTubeVideoUrl(url)) {
    throw new UnsupportedFeaturedSlideError('Only a YouTube video link can be featured');
  }
}
