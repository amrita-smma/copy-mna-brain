'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, SquareDashedMousePointer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export interface InsightElementPopoverProps {
  /** The picked element's tag, for the accessible name only — never shown. */
  label: string;
  /** How many elements the selection holds; the box speaks for all of them. */
  count?: number;
  /** The selection is words the user highlighted, not elements. */
  textPick?: boolean;
  anchor: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}

/**
 * Anchored prompt box rendered in the host page over the sandboxed iframe.
 *
 * It floats directly adjacent to the picked element (by bounding rect coordinates
 * delivered across the postMessage bridge), and allows the user to send an inline
 * instruction to the AI CoPilot targeted at that element.
 *
 * The header displays the selection count rather than element names.
 */
export function InsightElementPopover({
  label,
  count = 1,
  textPick = false,
  anchor,
  onSubmit,
  onClose,
}: InsightElementPopoverProps) {
  const [instruction, setInstruction] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({
    top: anchor.top + anchor.height + 8,
    left: anchor.left,
  });

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const parent = popover.offsetParent as HTMLElement | null;
    const containerWidth = parent ? parent.clientWidth : window.innerWidth;
    const containerHeight = parent ? parent.clientHeight : window.innerHeight;

    const popoverWidth = popover.offsetWidth || 320;
    const popoverHeight = popover.offsetHeight || 130;

    let top = anchor.top + anchor.height + 8;
    // Flip above the element if it would fall below the container bounds
    if (top + popoverHeight > containerHeight && anchor.top - popoverHeight - 8 >= 0) {
      top = anchor.top - popoverHeight - 8;
    }

    // Clamp left so it never overflows the container's right edge
    const maxLeft = Math.max(8, containerWidth - popoverWidth - 8);
    const left = Math.max(8, Math.min(anchor.left, maxLeft));

    setCoords({ top, left });
  }, [anchor]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSubmit = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={
        textPick
          ? 'Ask CoPilot about the highlighted text'
          : count > 1
            ? `Ask CoPilot about ${count} selected elements`
            : `Ask CoPilot about the selected <${label}>`
      }
      style={{ top: coords.top, left: coords.left }}
      className="absolute z-50 w-80 rounded-lg border border-border bg-card p-3 shadow-lg text-card-foreground"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <SquareDashedMousePointer className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {textPick
            ? 'Highlighted text'
            : count > 1
              ? `${count} elements selected`
              : '1 element selected'}
        </span>
      </div>
      <Textarea
        autoFocus
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          count > 1
            ? 'Ask about these, or ask the CoPilot to change them…'
            : 'Ask about this, or ask the CoPilot to change it…'
        }
        rows={3}
        className="min-h-0 resize-none text-xs bg-background text-foreground border-border placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] leading-tight text-muted-foreground">
          {textPick ? '' : 'Ctrl/⌘-click or drag to add more'}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={handleSubmit}
          disabled={!instruction.trim()}
          aria-label="Send to CoPilot"
          className="h-7 gap-1.5 px-3 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <span>Send</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
