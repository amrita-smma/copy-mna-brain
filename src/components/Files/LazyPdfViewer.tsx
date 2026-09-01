'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

// react-pdf/pdfjs touches browser-only globals (DOMMatrix) at module scope,
// which crashes Next's server-side prerendering — load it client-only.
// Centralized here so every consumer gets `ssr: false` for free instead of
// having to remember to wrap the import themselves.
const LazyPdfViewer = dynamic(() => import('@/components/Files/PdfViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  ),
});

export default LazyPdfViewer;
