import * as React from 'react';

export interface VisualViewportState {
  /** Current visible viewport height in pixels, or null before measurement */
  viewportHeight: number | null;
  /** Top edge of the visible viewport relative to the layout viewport */
  offsetTop: number;
  /** Whether a textbox is focused, which is the app's keyboard mode toggle */
  isKeyboardOpen: boolean;
}

/**
 * Tracks the mobile visual viewport and whether the app should be in
 * "keyboard mode".
 *
 * Keyboard mode is intentionally focus-driven. If an editable textbox is
 * focused, the chat should behave like a smaller screen above the keyboard and
 * hide mobile chrome. When focus leaves the textbox, the normal mobile nav mode
 * comes back.
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
      const viewportHeight = Math.round(vv?.height ?? window.innerHeight);
      const offsetTop = Math.round(vv?.offsetTop ?? 0);
      const isKeyboardOpen = inputFocusedRef.current;

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
