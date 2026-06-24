'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import mammoth from 'mammoth';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, FileText, AlertCircle, Download, Presentation } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileType, setFileType] = useState<string>('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const detectFileType = () => {
      const extension = fileName.split('.').pop()?.toLowerCase();
      if (extension === 'pdf') return 'pdf';
      if (extension === 'docx' || extension === 'doc') return 'docx';
      if (extension === 'txt') return 'text';
      if (extension === 'md') return 'markdown';
      if (extension === 'png' || extension === 'jpg' || extension === 'jpeg') return 'image';
      return 'unknown';
    };

    const type = detectFileType();
    setFileType(type);

    const fetchContent = async () => {
      setLoading(true);
      setError(null);
      try {
        if (type === 'docx') {
          const response = await fetch(url);
          const arrayBuffer = await response.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer });
          setContent(result.value);
        } else if (type === 'text' || type === 'markdown') {
          const response = await fetch(url);
          const text = await response.text();
          setContent(text);
        }
      } catch (err) {
        console.error('Error fetching file content:', err);
        setError('Failed to load file preview');
      } finally {
        setLoading(false);
      }
    };

    if (type === 'image' || type === 'pdf' || type === 'unknown') {
      setLoading(false);
    } else {
      fetchContent();
    }
  }, [url, fileName]);

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
    router.push(`/presentation?${params.toString()}`);
  };

  const handleDownload = async () => {
    if (!onDownload) return;
    setDownloading(true);
    try {
      await onDownload();
    } finally {
      setDownloading(false);
    }
  };

  // Renders the file body to fill its container.
  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-muted/30 rounded-md border">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col h-full w-full items-center justify-center bg-muted/30 rounded-md border text-destructive gap-2">
          <AlertCircle className="h-8 w-8" />
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={!onDownload || downloading}>
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            Download instead
          </Button>
        </div>
      );
    }

    if (fileType === 'pdf') {
      return (
        <div className="h-full w-full rounded-md border overflow-hidden">
          <iframe src={`${url}#toolbar=0`} className="w-full h-full" title="PDF Preview" />
        </div>
      );
    }

    if (fileType === 'image') {
      return (
        <div className="h-full w-full rounded-md border overflow-auto bg-muted/20 flex items-center justify-center p-4">
          <img src={url} alt={fileName} className="max-w-full max-h-full object-contain" />
        </div>
      );
    }

    if (fileType === 'docx') {
      return (
        <ScrollArea className="h-full w-full rounded-md border p-6 bg-white">
          <div
            className="prose prose-sm max-w-none text-black"
            dangerouslySetInnerHTML={{ __html: content || '' }}
          />
        </ScrollArea>
      );
    }

    if (fileType === 'markdown') {
      return (
        <ScrollArea className="h-full w-full rounded-md border p-6 bg-muted/10">
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || ''}</ReactMarkdown>
          </div>
        </ScrollArea>
      );
    }

    if (fileType === 'text') {
      return (
        <ScrollArea className="h-full w-full rounded-md border p-4 bg-muted/30">
          <pre className="text-xs whitespace-pre-wrap font-sans">{content}</pre>
        </ScrollArea>
      );
    }

    return (
      <div className="flex flex-col h-full w-full items-center justify-center bg-muted/30 rounded-md border gap-4">
        <FileText className="h-12 w-12 text-muted-foreground opacity-50" />
        <div className="text-center">
          <p className="font-medium">No preview available</p>
          <p className="text-sm text-muted-foreground">Supported previews: PDF, DOCX, TXT, MD, PNG, JPG, JPEG</p>
        </div>
        <Button variant="outline" onClick={handleDownload} disabled={!onDownload || downloading}>
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Download File
        </Button>
      </div>
    );
  };

  // Only offer the full-screen button once there is something to show.
  const canFullscreen = !loading && !error;

  return (
    <div className="relative h-full w-full min-h-[300px]">
      {canFullscreen && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={openInPresentation}
          title="Open in the Presentation tab"
          className="absolute right-2 top-2 z-10 gap-1.5 opacity-80 shadow hover:opacity-100"
        >
          <Presentation className="h-4 w-4" />
          Present
        </Button>
      )}
      {renderBody()}
    </div>
  );
}
