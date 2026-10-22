/**
 * Where a swiped list row settles when the finger lifts, iOS Mail style.
 * Client safe: pure, so the thresholds are tested apart from the gesture.
 *
 * - Swipe right past `LEADING_TRIGGER_PX`: run the leading action (read /
 *   unread) and spring back.
 * - Swipe left past `FULL_SWIPE_RATIO` of the row: run the primary trailing
 *   action (pin / unpin) and spring back.
 * - Swipe left past `TRAY_OPEN_PX`: leave the trailing actions open.
 * - Anything shorter springs back closed.
 */

export const LEADING_TRIGGER_PX = 72;
export const TRAY_OPEN_PX = 44;
export const FULL_SWIPE_RATIO = 0.5;

export type SwipeOutcome =
  | { kind: 'leading' }
  | { kind: 'trailing' }
  | { kind: 'open' }
  | { kind: 'close' };

export interface SwipeInput {
  /** Where the row sits now (negative = moved left). */
  x: number;
  /** Horizontal speed at release, px/s (negative = flicking left). */
  velocityX: number;
  rowWidth: number;
  hasLeading: boolean;
  hasTrailing: boolean;
}

/** A quick flick counts as a longer swipe. */
const FLICK_PX_PER_S = 600;
const FLICK_BONUS_PX = 60;

export function resolveSwipe({ x, velocityX, rowWidth, hasLeading, hasTrailing }: SwipeInput): SwipeOutcome {
  const flick = Math.abs(velocityX) > FLICK_PX_PER_S ? Math.sign(velocityX) * FLICK_BONUS_PX : 0;
  const reach = x + flick;
  if (reach > 0) return hasLeading && reach >= LEADING_TRIGGER_PX ? { kind: 'leading' } : { kind: 'close' };
  if (!hasTrailing) return { kind: 'close' };
  if (-x >= rowWidth * FULL_SWIPE_RATIO) return { kind: 'trailing' };
  if (-reach >= TRAY_OPEN_PX) return { kind: 'open' };
  return { kind: 'close' };
}

/** Whether the row has been dragged far enough left that letting go runs the primary action. */
export function isFullSwipe(x: number, rowWidth: number): boolean {
  return -x >= rowWidth * FULL_SWIPE_RATIO;
}
