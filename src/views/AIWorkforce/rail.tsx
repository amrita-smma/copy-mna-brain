'use client';

import * as React from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

export function RailGroup({
  label,
  count,
  hint,
  children,
}: {
  label: string;
  count: number;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1">
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
      </div>
      {children}
    </div>
  );
}

export function RailItem({
  icon,
  iconClass,
  title,
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
}: {
  icon: React.ReactNode;
  iconClass: string;
  title: React.ReactNode;
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
}) {
  return (
    <button
      type="button"
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
}
