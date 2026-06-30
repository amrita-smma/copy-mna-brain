'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function RailGroup({
  label,
  count,
  hint,
  collapsible = false,
  defaultOpen = true,
  children,
  'data-testid': testId,
}: {
  label: string;
  count: number;
  hint?: string;
  // When true, the header becomes a toggle button and children hide when
  // collapsed. Sections that always need visibility (e.g. NEED ACTION,
  // IN PROGRESS) should leave this false.
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
  'data-testid'?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const isOpen = collapsible ? open : true;

  const header = (
    <>
      {collapsible &&
        (isOpen ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        ))}
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-[10px] font-semibold text-muted-foreground/70">
        · {count}
      </span>
      {hint && (
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          {hint}
        </span>
      )}
    </>
  );

  return (
    <div data-testid={testId}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 px-2.5 pt-1.5 pb-1 rounded-md hover:bg-muted/40 transition-colors"
          aria-expanded={isOpen}
        >
          {header}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1">
          {header}
        </div>
      )}
      {isOpen && children}
    </div>
  );
}

export function RailItem({
  icon,
  iconClass,
  title,
  tooltipText,
  meta,
  active,
  showDragHandle,
  onClick,
  draggable,
  isDragging,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  'data-testid': testId,
}: {
  icon: React.ReactNode;
  iconClass: string;
  title: React.ReactNode;
  // Plain-text version of the title shown in a hover tooltip. Used because
  // the title cell is `truncate`d and long task names get cut off otherwise.
  tooltipText?: string;
  meta: React.ReactNode;
  active?: boolean;
  showDragHandle?: boolean;
  onClick?: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLButtonElement>) => void;
  'data-testid'?: string;
}) {
  const button = (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      className={cn(
        'group relative w-full grid grid-cols-[14px_22px_1fr] items-center gap-2 rounded-md px-2.5 py-2 text-left transition-all',
        active ? 'bg-card shadow-sm' : 'hover:bg-card/70',
        isDragging && 'opacity-40',
      )}
    >
      {active && (
        <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r bg-violet-500" />
      )}
      <span
        className={cn(
          'h-3 w-3 grid place-items-center cursor-grab transition-opacity',
          showDragHandle
            ? 'opacity-0 group-hover:opacity-60 text-muted-foreground'
            : 'opacity-0',
        )}
      >
        {showDragHandle && <GripVertical className="h-3 w-3" />}
      </span>
      <span className={cn('h-[22px] w-[22px] rounded-md grid place-items-center', iconClass)}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-foreground truncate">
          {title}
        </span>
        <span className="block mt-0.5 text-[10.5px] text-muted-foreground">{meta}</span>
      </span>
    </button>
  );

  if (!tooltipText) return button;

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[260px] text-xs leading-snug break-words"
      >
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}
