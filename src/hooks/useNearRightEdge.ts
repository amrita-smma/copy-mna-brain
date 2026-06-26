"use client";

import { useCallback, useState } from "react";

/**
 * Tracks whether the cursor is within `threshold` px of the right edge of the
 * element the returned handlers are attached to. Useful for revealing
 * edge-anchored controls (e.g. a row actions menu) only when the user moves
 * toward the right side of a table.
 */
export function useNearRightEdge(threshold = 180) {
  const [nearEdge, setNearEdge] = useState(false);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      // Measure against the visible (scroll) container rather than the element
      // itself, so wide tables that overflow horizontally still reveal the
      // control at the visible right edge instead of the scrolled-away column.
      const el = e.currentTarget.parentElement ?? e.currentTarget;
      const rect = el.getBoundingClientRect();
      const distanceFromRight = rect.right - e.clientX;
      setNearEdge(distanceFromRight >= 0 && distanceFromRight <= threshold);
    },
    [threshold],
  );

  const onMouseLeave = useCallback(() => setNearEdge(false), []);

  return { nearEdge, edgeHandlers: { onMouseMove, onMouseLeave } };
}
