'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { apiRequest } from '@/lib/api/client';
import { addCompanyLink, clearFeaturedSlide, featureDealDocument, featureDealLink } from '@/lib/api/pipeline';
import { detectFileKind, isFeaturableFileKind } from '@/lib/fileType';
import { isYouTubeVideoUrl } from '@/lib/media/youtube';
import type { ExistingAttachmentOption } from '@/components/pipeline/ExistingAttachmentPicker';

/**
 * The company's Featured Slide: one uploaded deck or recording
 * (`deal_documents.is_featured`) or one YouTube link (`deal_links.is_featured`).
 */
export type FeaturedSlideItem =
  | { kind: 'document'; id: string; name: string; filePath: string }
  | { kind: 'link'; id: string; name: string; url: string };

/** What every surface that shows the featured slide needs to render it. */
export interface FeaturedSlideState {
  item: FeaturedSlideItem | null;
  /** Signed preview URL (a document) or the YouTube URL (a link); null while loading or unavailable. */
  url: string | null;
  loading: boolean;
  onDownload: () => Promise<void> | void;
}

interface FeaturableDocument {
  id: string;
  file_name: string;
  file_path: string;
  is_featured: boolean;
}

interface FeaturableLink {
  id: string;
  url: string;
  title: string | null;
  is_featured?: boolean;
}

interface UseFeaturedSlideOptions<D extends FeaturableDocument> {
  companyId: string;
  /** Pipeline stage stamped on a new upload or link. */
  stage: string;
  documents: D[];
  links: FeaturableLink[];
  /** False while the host is closed (the dialog) — skips the preview-URL fetch. */
  enabled?: boolean;
  /** Re-reads the company's documents and links after a change. */
  refresh: () => Promise<void> | void;
  downloadDocument: (doc: D) => Promise<void> | void;
}

const DOC_PREFIX = 'document:';
const LINK_PREFIX = 'link:';

/**
 * Featured Slide state and actions, shared by `CompanyDetailDialog` and the
 * `CompanyDetail` page so the two cannot drift apart. The section renders it
 * with `FeaturedSlideSection`; the Voting tab takes `slide` as-is.
 */
export function useFeaturedSlide<D extends FeaturableDocument>({
  companyId,
  stage,
  documents,
  links,
  enabled = true,
  refresh,
  downloadDocument,
}: UseFeaturedSlideOptions<D>) {
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Keyed by document id, so a replaced slide never shows the previous
  // document's URL and reads as loading until its own URL lands.
  const [preview, setPreview] = useState<{ documentId: string; url: string | null } | null>(null);

  const featuredDocument = documents.find((d) => d.is_featured) ?? null;
  const featuredLink = featuredDocument ? null : (links.find((l) => l.is_featured) ?? null);

  const item: FeaturedSlideItem | null = featuredDocument
    ? {
        kind: 'document',
        id: featuredDocument.id,
        name: featuredDocument.file_name,
        filePath: featuredDocument.file_path,
      }
    : featuredLink
      ? {
          kind: 'link',
          id: featuredLink.id,
          name: featuredLink.title || 'YouTube video',
          url: featuredLink.url,
        }
      : null;

  // A document needs a fresh signed preview URL whenever it changes (new
  // upload, replace, removal); a YouTube link is its own URL.
  const featuredDocumentId = featuredDocument?.id ?? null;
  useEffect(() => {
    if (!enabled || !featuredDocumentId) return;
    let cancelled = false;
    apiRequest<{ url: string }>(
      `/api/deal-documents/download-url?id=${encodeURIComponent(featuredDocumentId)}&preview=true`,
    )
      .then((data) => {
        if (!cancelled) setPreview({ documentId: featuredDocumentId, url: data.url });
      })
      .catch((error) => {
        console.error('Error loading featured slide preview:', error);
        if (!cancelled) setPreview({ documentId: featuredDocumentId, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, featuredDocumentId]);

  const previewReady = featuredDocumentId !== null && preview?.documentId === featuredDocumentId;

  // Attachments and links already on the company that could be featured
  // as-is, without re-uploading — offered via the search dropdown.
  const options = useMemo<ExistingAttachmentOption[]>(
    () => [
      ...documents
        .filter((d) => isFeaturableFileKind(detectFileKind(d.file_name)))
        .map((d) => ({ id: `${DOC_PREFIX}${d.id}`, file_name: d.file_name })),
      ...links
        .filter((l) => isYouTubeVideoUrl(l.url))
        .map((l) => ({ id: `${LINK_PREFIX}${l.id}`, file_name: l.title || l.url, youtube: true })),
    ],
    [documents, links],
  );

  const selectedOptionId = item ? `${item.kind === 'document' ? DOC_PREFIX : LINK_PREFIX}${item.id}` : null;

  // Uploads (or replaces) the featured slide: presign → PUT → register with
  // `featured: true`, so the service supersedes the previous featured item
  // instead of appending to it.
  const upload = async (file: File) => {
    if (!isFeaturableFileKind(detectFileKind(file.name))) {
      toast.error('Only PDF, PPTX, video or audio files can be featured');
      return;
    }

    setUploading(true);
    try {
      const contentType = file.type || 'application/octet-stream';

      let uploadUrlData: { uploadUrl: string; key: string };
      try {
        uploadUrlData = await apiRequest(
          `/api/deal-documents/upload-url?dealId=${encodeURIComponent(companyId)}&fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(contentType)}`,
        );
      } catch (apiErr) {
        throw new Error(
          (apiErr as Error)?.message ||
            'Could not reach server. Check your connection and that the app is running.',
        );
      }
      const { uploadUrl, key } = uploadUrlData;

      let s3Res: Response;
      try {
        s3Res = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': contentType },
        });
      } catch {
        throw new Error(
          'Upload to storage failed (network error). Ensure AWS_S3_BUCKET matches your bucket and the bucket has CORS enabled for this origin.',
        );
      }
      if (!s3Res.ok) throw new Error('Failed to upload file to storage');

      try {
        await apiRequest('/api/deal-documents', {
          method: 'POST',
          body: JSON.stringify({
            dealId: companyId,
            key,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || null,
            stage,
            featured: true,
          }),
        });
      } catch (apiErr) {
        throw new Error((apiErr as Error)?.message || 'Could not register document. Check your connection.');
      }

      await refresh();
      toast.success('Featured slide uploaded');
    } catch (error) {
      console.error('Featured slide upload error:', error);
      toast.error((error as Error)?.message || 'Failed to upload featured slide');
    } finally {
      setUploading(false);
    }
  };

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    setSaving(true);
    try {
      await action();
      await refresh();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error((error as Error)?.message || failure);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const selectExisting = (optionId: string) => {
    const action = optionId.startsWith(LINK_PREFIX)
      ? () => featureDealLink(companyId, optionId.slice(LINK_PREFIX.length))
      : () => featureDealDocument(companyId, optionId.slice(DOC_PREFIX.length));
    return run(action, 'Featured slide updated', 'Failed to set featured slide');
  };

  /** Adds a YouTube link to the timeline and features it in one step. */
  const addYouTubeLink = async (url: string, title?: string) => {
    const trimmed = url.trim();
    if (!isYouTubeVideoUrl(trimmed)) {
      toast.error('Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…)');
      return false;
    }
    return run(
      () => addCompanyLink(companyId, trimmed, title?.trim() || undefined, stage, null, true),
      'Featured slide updated',
      'Failed to feature YouTube link',
    );
  };

  const remove = () =>
    run(() => clearFeaturedSlide(companyId), 'Featured slide removed', 'Failed to remove featured slide');

  const slide: FeaturedSlideState = {
    item,
    url: item?.kind === 'link' ? item.url : previewReady ? preview.url : null,
    loading: item?.kind === 'document' && !previewReady,
    onDownload: async () => {
      if (featuredDocument) await downloadDocument(featuredDocument);
    },
  };

  return {
    slide,
    options,
    selectedOptionId,
    busy: uploading || saving,
    uploading,
    upload,
    selectExisting,
    addYouTubeLink,
    remove,
  };
}

export type FeaturedSlideController = ReturnType<typeof useFeaturedSlide>;
