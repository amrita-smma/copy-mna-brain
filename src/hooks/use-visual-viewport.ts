import * as React from 'react';

export interface VisualViewportMetrics {
  /**
   * Height of the visual viewport (the area not covered by the on-screen
   * keyboard) in px, or `null` until the first measurement / on browsers
   * without `window.visualViewport`. Callers should fall back to a CSS
   * `100dvh` value while this is `null`.
   */
  height: number | null;
  /** Top offset of the visual viewport relative to the layout viewport. */
  offsetTop: number;
  /**
   * Height of the on-screen keyboard (or other interactive widget) currently
   * covering the bottom of the layout viewport, in px. `0` when no keyboard is
   * open.
   */
  keyboardInset: number;
}

const EMPTY: VisualViewportMetrics = { height: null, offsetTop: 0, keyboardInset: 0 };

/**
 * Tracks the browser's visual viewport so a full-screen layout can resize
 * itself to the space *above* the on-screen keyboard. On mobile the keyboard
 * shrinks the visual viewport (not the `100dvh` layout viewport), so reading it
 * is the only reliable, cross-browser way to know how much room the keyboard
 * is taking.
 */
export function useVisualViewport(): VisualViewportMetrics {
  const [metrics, setMetrics] = React.useState<VisualViewportMetrics>(EMPTY);

  React.useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) {
      setMetrics(EMPTY);
      return;
    }

    const update = () => {
      const keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setMetrics({ height: vv.height, offsetTop: vv.offsetTop, keyboardInset });
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return metrics;
}
