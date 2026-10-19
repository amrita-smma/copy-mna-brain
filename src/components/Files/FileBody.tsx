'use client';

import { useEffect, useState } from 'react';
import mammoth from 'mammoth';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, FileText, AlertCircle, Download } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import PdfViewer, { LazyPdfSlideViewer } from '@/components/Files/LazyPdfViewer';
import { detectFileKind } from '@/lib/fileType';

interface FileBodyProps {
  url: string;
  fileName: string;
  onDownload?: () => Promise<void>;
  /**
   * How a PDF is laid out: `scroll` (default) is the continuous, searchable
   * reader; `slides` shows one page at a time like a PowerPoint deck, which
   * is what the Presentation page uses.
   */
  pdfLayout?: 'scroll' | 'slides';
}

/**
 * Renders the appropriate preview for a file's kind (PDF, PPTX, DOCX, image,
 * text, markdown — falling back to a download prompt for anything else),
 * filling its container. Shared between `FilePreview` (the dialog preview)
 * and the Presentation tab's persistent full-screen viewer so both support
 * exactly the same set of "presentable" file kinds — a file that previews
 * fine in a dialog can't dead-end into "not supported" once presented.
 */
export default function FileBody({ url, fileName, onDownload, pdfLayout = 'scroll' }: FileBodyProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const fileType = detectFileKind(fileName);

  useEffect(() => {
    let cancelled = false;

    const fetchContent = async () => {
      setLoading(true);
      setError(null);
      try {
        if (fileType === 'docx') {
          const response = await fetch(url);
          const arrayBuffer = await response.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer });
          if (!cancelled) setContent(result.value);
        } else if (fileType === 'text' || fileType === 'markdown') {
          const response = await fetch(url);
          const text = await response.text();
          if (!cancelled) setContent(text);
        }
      } catch (err) {
        console.error('Error fetching file content:', err);
        if (!cancelled) setError('Failed to load file preview');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (fileType === 'image' || fileType === 'pdf' || fileType === 'pptx' || fileType === 'unknown') {
      setLoading(false);
      setError(null);
    } else {
      fetchContent();
    }

    return () => {
      cancelled = true;
    };
  }, [url, fileType]);

  const handleDownload = async () => {
    if (!onDownload) return;
    setDownloading(true);
    try {
      await onDownload();
    } finally {
      setDownloading(false);
    }
  };

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
        {pdfLayout === 'slides' ? (
          // Keyed on `url` so a newly presented file always starts on slide 1.
          <LazyPdfSlideViewer key={url} url={url} />
        ) : (
          <PdfViewer url={url} />
        )}
      </div>
    );
  }

  if (fileType === 'pptx') {
    return (
      <div className="h-full w-full rounded-md border overflow-hidden">
        <iframe
          src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`}
          className="w-full h-full"
          title={fileName || 'Presentation'}
        />
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
        <p className="text-sm text-muted-foreground">Supported previews: PDF, DOCX, PPTX, TXT, MD, PNG, JPG, JPEG</p>
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
}
