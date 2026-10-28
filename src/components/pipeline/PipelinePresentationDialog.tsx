'use client';

import { useRef, useState } from 'react';
import { Download, Loader2, Maximize2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { downloadPipelinePresentationPptx } from '@/lib/api/pipeline';
import type { PipelinePresentation } from '@/lib/pipeline/presentation';

// The presentation is a slide document in the StarCapital table syntax, so it
// keeps the template's fixed colours in both themes rather than following the app
// palette — the same choice the Fund Management report makes.
const TITLE_NAVY = '#0A2440';
const HEADER_NAVY = '#1A3F65';
const MARKER = '#054068';
const RULE = '#D0CECE';
const INK = '#212121';

function PresentationDocument({ deck }: { deck: PipelinePresentation }) {
  const count = deck.rows.length;
  const columns = deck.columns;
  // Columns as percentages of the table, from their slide widths.
  const totalWidth = columns.reduce((sum, c) => sum + c.width, 0) || 1;
  const columnWidth = (width: number) => `${((width / totalWidth) * 100).toFixed(2)}%`;
  return (
    <div style={{ fontFamily: 'Arial, Helvetica, sans-serif', color: INK }}>
      <h2 className="text-[22px] leading-tight" style={{ color: TITLE_NAVY }}>
        {deck.title}
      </h2>
      {deck.subtitle && <p className="mt-1 text-sm">{deck.subtitle}</p>}
      <div className="mt-3 flex gap-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-2 w-2 rounded-full" style={{ backgroundColor: MARKER }} />
        ))}
      </div>
      <p className="mt-3 text-sm font-bold" style={{ color: TITLE_NAVY }}>
        {count === 0 ? 'Companies' : `Companies 1–${count} of ${count}`}
      </p>

      <table className="mt-3 w-full table-fixed border-collapse text-[13px]">
        <colgroup>
          {columns.map((c, i) => (
            <col key={i} style={{ width: columnWidth(c.width) }} />
          ))}
        </colgroup>
        <thead>
          <tr style={{ backgroundColor: HEADER_NAVY }} className="text-white">
            {columns.map((c, i) => (
              <th
                key={i}
                className={cn('px-2.5 py-2.5 font-bold', c.align === 'right' ? 'text-right' : 'text-left')}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {count === 0 ? (
            <tr style={{ borderBottom: `1px solid ${RULE}` }}>
              <td colSpan={columns.length} className="py-8 text-center">
                No companies match the current view.
              </td>
            </tr>
          ) : (
            deck.rows.map((row, ri) => (
              <tr key={ri} style={{ borderBottom: `1px solid ${RULE}` }}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      'break-words px-2.5 py-2',
                      columns[ci]?.align === 'right' && 'text-right tabular-nums',
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Pipeline page's "Present" view: the companies the table is showing,
 * as one table in the StarCapital template's table syntax, with a Download
 * button that saves the same rows as a paginated .pptx — on the StarCapital
 * master or on plain slides, per the workspace's PowerPoint Template.
 */
export function PipelinePresentationDialog({
  open,
  onOpenChange,
  deck,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deck: PipelinePresentation;
}) {
  const documentRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const enterFullscreen = () => {
    documentRef.current?.requestFullscreen?.().catch(() => {});
  };

  const download = async () => {
    setDownloading(true);
    try {
      const { blob, fileName } = await downloadPipelinePresentationPptx(deck);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error((err as Error).message || 'Could not download the presentation');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] max-w-[min(1500px,96vw)] flex-col gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b bg-card px-4 py-2.5 pr-12">
          <DialogTitle className="text-sm font-medium">Pipeline presentation</DialogTitle>
          <DialogDescription className="sr-only">
            The companies and open columns of the pipeline table, as a slide table.
          </DialogDescription>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={enterFullscreen}>
              <Maximize2 className="h-3.5 w-3.5" />
              Full screen
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              data-testid="pipeline-present-download"
              disabled={downloading}
              onClick={download}
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Download PPTX
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-muted p-4">
          <div ref={documentRef} className="mx-auto min-w-[1100px] overflow-auto bg-white px-8 py-7">
            <PresentationDocument deck={deck} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
