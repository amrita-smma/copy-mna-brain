/**
 * Pure navigation helpers for the slide-style PDF viewer
 * (`PdfSlideViewer`). Kept framework-free so the keyboard, wheel and click
 * mappings can be unit tested without a DOM.
 */

export type SlideStep = -1 | 0 | 1;

/** Clamps a 1-based page number into `[1, numPages]`. */
export function clampPage(page: number, numPages: number): number {
  if (numPages < 1) return 1;
  return Math.min(numPages, Math.max(1, Math.round(page)));
}

export type SlideKeyAction = { type: 'step'; step: -1 | 1 } | { type: 'first' } | { type: 'last' };

/**
 * Maps a `KeyboardEvent.key` to a slide action, mirroring PowerPoint's
 * slideshow keys. Returns `null` for keys the viewer should leave alone.
 */
export function keyToSlideAction(key: string, shiftKey = false): SlideKeyAction | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case 'Enter':
    case 'n':
    case 'N':
      return { type: 'step', step: 1 };
    case ' ':
      return { type: 'step', step: shiftKey ? -1 : 1 };
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
    case 'p':
    case 'P':
      return { type: 'step', step: -1 };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    default:
      return null;
  }
}

/** Wheel distance (px) that must accumulate before one slide turn. */
export const WHEEL_THRESHOLD_PX = 40;
/** After a turn, wheel input is swallowed for this long so one flick = one slide. */
export const WHEEL_COOLDOWN_MS = 450;
/** A pause longer than this starts a fresh gesture (resets the accumulator). */
export const WHEEL_GESTURE_GAP_MS = 200;

export interface WheelState {
  accumulated: number;
  lastEventAt: number;
  lockedUntil: number;
}

export function initialWheelState(): WheelState {
  return { accumulated: 0, lastEventAt: 0, lockedUntil: 0 };
}

/** `WheelEvent.deltaMode` line/page units, normalised to pixels. */
export function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 800;
  return delta;
}

/**
 * Folds one wheel event into the gesture state and decides whether it turns
 * a slide. Trackpads fire dozens of small events per swipe (plus a long
 * inertial tail), so a turn needs a threshold of accumulated travel, and the
 * cooldown after it absorbs the tail — otherwise one swipe would skip
 * several slides. Horizontal travel counts too, so a sideways swipe works.
 */
export function reduceWheel(
  state: WheelState,
  input: { deltaX: number; deltaY: number; deltaMode: number; now: number },
): { state: WheelState; step: SlideStep } {
  const { now } = input;
  const dx = normalizeWheelDelta(input.deltaX, input.deltaMode);
  const dy = normalizeWheelDelta(input.deltaY, input.deltaMode);
  const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;

  if (now < state.lockedUntil) {
    return { state: { ...state, accumulated: 0, lastEventAt: now }, step: 0 };
  }

  const fresh = now - state.lastEventAt > WHEEL_GESTURE_GAP_MS;
  let accumulated = fresh ? 0 : state.accumulated;
  // A reversal mid-gesture starts counting from zero in the new direction.
  if (accumulated !== 0 && Math.sign(accumulated) !== Math.sign(delta)) accumulated = 0;
  accumulated += delta;

  if (Math.abs(accumulated) >= WHEEL_THRESHOLD_PX) {
    return {
      state: { accumulated: 0, lastEventAt: now, lockedUntil: now + WHEEL_COOLDOWN_MS },
      step: accumulated > 0 ? 1 : -1,
    };
  }
  return { state: { ...state, accumulated, lastEventAt: now }, step: 0 };
}

/** Fraction of the stage width, from the left edge, that steps backwards on click. */
export const CLICK_BACK_ZONE = 0.3;

/**
 * A click on the left of the slide goes back; anywhere else advances, the
 * way clicking through a PowerPoint slideshow does.
 */
export function clickToStep(offsetX: number, width: number): -1 | 1 {
  if (width <= 0) return 1;
  return offsetX / width < CLICK_BACK_ZONE ? -1 : 1;
}

/**
 * Largest page width that fits the slide inside the stage on both axes,
 * preserving the page's aspect ratio (height / width).
 */
export function fitPageWidth(stageWidth: number, stageHeight: number, aspectRatio: number): number {
  if (stageWidth <= 0 || stageHeight <= 0 || aspectRatio <= 0) return Math.max(0, stageWidth);
  return Math.floor(Math.min(stageWidth, stageHeight / aspectRatio));
}
