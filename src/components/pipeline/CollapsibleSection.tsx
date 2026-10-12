'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface CollapsibleSectionProps {
  title: string;
  description?: string;
  /** Rendered to the left of the title — typically a lucide icon. */
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * An opaque, bordered section whose header toggles its body open and closed.
 *
 * Used by the "Additional Context" tab on both `CompanyDetail` (full page) and
 * `CompanyDetailDialog` (pipeline dialog) so Context and Featured Slide can sit
 * in one tab without either one pushing the other off screen.
 */
export function CollapsibleSection({
  title,
  description,
  icon,
  defaultOpen = true,
  children,
  className,
  contentClassName,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('rounded-lg border bg-card', className)}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-start justify-between gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-muted"
        >
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 font-semibold">
              {icon}
              <span className="truncate">{title}</span>
            </div>
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform mt-1',
              open && 'rotate-180',
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('border-t px-4 py-4', contentClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default CollapsibleSection;
