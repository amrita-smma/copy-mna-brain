import * as React from 'react';

export interface VisualViewportState {
  /** Current visible viewport height in pixels, or null before measurement */
  viewportHeight: number | null;
  /** Top edge of the visible viewport relative to the layout viewport */
  offsetTop: number;
  /** Whether the on-screen keyboard is up (drives the app's keyboard mode) */
  isKeyboardOpen: boolean;
}

/**
 * Minimum shrink (in px) of the visual viewport, relative to the keyboard-closed
 * baseline, that we treat as "the on-screen keyboard is up". Filters out small
 * browser-chrome changes such as the URL bar collapsing.
 */
const KEYBOARD_HEIGHT_THRESHOLD = 150;

/**
 * Tracks the mobile visual viewport and whether the app should be in
 * "keyboard mode".
 *
 * Keyboard mode requires BOTH an editable textbox to be focused AND the visual
 * viewport to be meaningfully shrunk. Focus alone is not enough: dismissing the
 * keyboard from the keyboard itself (the hide-keyboard key or a swipe-down) does
 * NOT blur the input, so a focus-only signal stays stuck "open". Keying off the
 * viewport height too means an external dismiss — which always fires a
 * visualViewport `resize` — correctly flips us back to nav mode.
 */
export function useVisualViewport(): VisualViewportState {
  const [state, setState] = React.useState<VisualViewportState>({
    viewportHeight: null,
    offsetTop: 0,
    isKeyboardOpen: false,
  });

  React.useEffect(() => {
    const vv = window.visualViewport;
    const inputFocusedRef = { current: false };
    // Tallest viewport seen while no textbox is focused — the "keyboard closed"
    // baseline. window.innerHeight alone is unreliable: some Android browsers
    // shrink it when the keyboard opens, so a tracked max is more robust.
    const baseHeightRef = { current: 0 };
    const timeouts: number[] = [];
    let frame = 0;

    const isEditableElement = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName.toLowerCase();
      return (
        tagName === 'input' ||
        tagName === 'textarea' ||
        target.isContentEditable
      );
    };

    const update = () => {
      const layoutHeight = window.innerHeight;
      const viewportHeight = Math.round(vv?.height ?? layoutHeight);
      const offsetTop = Math.round(vv?.offsetTop ?? 0);

      // Only grow the baseline while nothing is focused — otherwise an open
      // keyboard would poison it. layoutHeight is folded in so we have a sane
      // baseline immediately, before the first unfocused measurement.
      if (!inputFocusedRef.current) {
        baseHeightRef.current = Math.max(
          baseHeightRef.current,
          viewportHeight,
          layoutHeight,
        );
      }
      const base = baseHeightRef.current || layoutHeight;
      const viewportShrunk = base - viewportHeight > KEYBOARD_HEIGHT_THRESHOLD;
      const isKeyboardOpen = inputFocusedRef.current && viewportShrunk;

      setState((prev) => {
        if (
          prev.viewportHeight === viewportHeight &&
          prev.offsetTop === offsetTop &&
          prev.isKeyboardOpen === isKeyboardOpen
        ) {
          return prev;
        }
        return { viewportHeight, offsetTop, isKeyboardOpen };
      });
    };

    const updateDuringKeyboardAnimation = () => {
      update();
      frame = window.requestAnimationFrame(update);
      for (const delay of [50, 100, 200, 350, 600]) {
        timeouts.push(window.setTimeout(update, delay));
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      inputFocusedRef.current = isEditableElement(event.target);
      updateDuringKeyboardAnimation();
    };

    const handleFocusOut = () => {
      inputFocusedRef.current = false;
      timeouts.push(window.setTimeout(update, 100));
    };

    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      window.cancelAnimationFrame(frame);
      timeouts.forEach((timeout) => window.clearTimeout(timeout));
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  return state;
}
