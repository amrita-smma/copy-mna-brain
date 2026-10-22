'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isFullSwipe, resolveSwipe } from '@/lib/mobile/swipe';

/** One action revealed by a swipe. */
export interface SwipeAction {
  key: string;
  label: string;
  icon: LucideIcon;
  /** The action's colour, as background and text classes. */
  className: string;
  onSelect: () => void;
}

/** Each trailing action's width when the tray rests open. */
const ACTION_WIDTH = 76;
const SPRING = { type: 'spring', stiffness: 500, damping: 42 } as const;

function buzz() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(8);
}

/**
 * A list row you swipe, iOS Mail style. Swiping right runs `leading` (read or
 * unread). Swiping left reveals `trailing`; a long swipe runs the first one
 * (pin or unpin), which stretches to fill the row as it is about to fire.
 * Only one row rests open at a time: the parent owns `open`.
 */
export function SwipeRow({
  leading,
  trailing = [],
  open,
  onOpenChange,
  children,
  className,
}: {
  leading?: SwipeAction;
  trailing?: SwipeAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const rowRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const draggedRef = useRef(false);
  const armedRef = useRef(false);
  const trayWidth = ACTION_WIDTH * trailing.length;
  const transition = reduce ? { duration: 0 } : SPRING;

  // Another row opened, or this one was told to close.
  useEffect(() => {
    if (!open && x.get() !== 0) void animate(x, 0, transition);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Buzz once as a left swipe crosses the point where letting go fires.
  useMotionValueEvent(x, 'change', (v) => {
    const width = rowRef.current?.offsetWidth ?? 0;
    const armed = isFullSwipe(v, width) && trailing.length > 0;
    if (armed !== armedRef.current) {
      armedRef.current = armed;
      if (armed) buzz();
    }
  });

  const leadingOpacity = useTransform(x, [0, 24], [0, 1]);
  const trailingOpacity = useTransform(x, [-24, 0], [1, 0]);
  // The primary action stretches over the others' room as the swipe goes long.
  const primaryWidth = useTransform(x, (v) => Math.max(ACTION_WIDTH, -v - ACTION_WIDTH * (trailing.length - 1)));

  const settle = (_: unknown, info: PanInfo) => {
    const outcome = resolveSwipe({
      x: x.get(),
      velocityX: info.velocity.x,
      rowWidth: rowRef.current?.offsetWidth ?? 0,
      hasLeading: !!leading,
      hasTrailing: trailing.length > 0,
    });
    if (outcome.kind === 'open') {
      void animate(x, -trayWidth, transition);
      onOpenChange(true);
      return;
    }
    void animate(x, 0, transition);
    onOpenChange(false);
    if (outcome.kind === 'leading') {
      buzz();
      leading?.onSelect();
    } else if (outcome.kind === 'trailing') {
      trailing[0]?.onSelect();
    }
  };

  const LeadingIcon = leading?.icon;
  const primary = trailing[0];

  return (
    <div ref={rowRef} className={cn('relative overflow-hidden', className)}>
      {leading && LeadingIcon && (
        <motion.div
          aria-hidden
          style={{ opacity: leadingOpacity }}
          className={cn('absolute inset-0 flex items-center gap-2 pl-6 text-sm font-medium', leading.className)}
        >
          <LeadingIcon className="h-5 w-5" />
          {leading.label}
        </motion.div>
      )}
      {trailing.length > 0 && (
        <motion.div style={{ opacity: trailingOpacity }} className="absolute inset-y-0 right-0 flex flex-row-reverse">
          {trailing.map((action) => {
            const Icon = action.icon;
            return (
              <motion.button
                key={action.key}
                type="button"
                // Reachable only while the tray is open; the swipe itself is the
                // touch path, and these stay out of the tab order when hidden.
                tabIndex={open ? 0 : -1}
                aria-hidden={!open}
                onClick={() => {
                  void animate(x, 0, transition);
                  onOpenChange(false);
                  action.onSelect();
                }}
                style={action === primary ? { width: primaryWidth } : { width: ACTION_WIDTH }}
                className={cn(
                  'flex h-full shrink-0 flex-col items-center justify-center gap-1 text-xs font-medium',
                  action.className,
                )}
              >
                <Icon className="h-5 w-5" />
                {action.label}
              </motion.button>
            );
          })}
        </motion.div>
      )}

      <motion.div
        drag="x"
        dragDirectionLock
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={{ left: -10_000, right: leading ? 10_000 : 0 }}
        style={{ x, touchAction: 'pan-y' }}
        onDragStart={() => {
          draggedRef.current = true;
        }}
        onDragEnd={settle}
        // A drag must not also tap the row; a tap on an open row closes it.
        onClickCapture={(e) => {
          if (draggedRef.current || open) {
            e.preventDefault();
            e.stopPropagation();
            draggedRef.current = false;
            if (open) {
              void animate(x, 0, transition);
              onOpenChange(false);
            }
          }
        }}
        onPointerDown={() => {
          draggedRef.current = false;
        }}
        // Keyboard: ← opens the trailing actions, → runs the leading one.
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' && trailing.length > 0) {
            e.preventDefault();
            void animate(x, -trayWidth, transition);
            onOpenChange(true);
          } else if (e.key === 'ArrowRight' && open) {
            e.preventDefault();
            void animate(x, 0, transition);
            onOpenChange(false);
          } else if (e.key === 'ArrowRight' && leading) {
            e.preventDefault();
            leading.onSelect();
          }
        }}
        className="relative bg-background"
      >
        {children}
      </motion.div>
    </div>
  );
}
