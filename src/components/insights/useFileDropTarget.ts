'use client';

import { useRef, useState } from 'react';

function carriesFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** True when the drag is over an open dialog, which handles its own drops. */
function overDialog(e: React.DragEvent): boolean {
  return e.target instanceof Element && e.target.closest('[role="dialog"]') !== null;
}

/**
 * Makes an element a drop target for one file dragged in from the desktop.
 * Text, links and in-page drags are ignored, and so is a drag over an open
 * dialog, since its own drop zone takes the file. `active` is true while a
 * file is over the element. Enter/leave are counted because both fire for
 * every child the pointer crosses.
 */
export function useFileDropTarget(onFile: (file: File, extraFiles: number) => void) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  const reset = () => {
    depth.current = 0;
    setActive(false);
  };

  const bind = {
    onDragEnter: (e: React.DragEvent) => {
      if (!carriesFiles(e) || overDialog(e)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!carriesFiles(e) || overDialog(e)) return;
      // Without this the browser opens the file instead of dropping it here.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!carriesFiles(e) || overDialog(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!carriesFiles(e) || overDialog(e)) return;
      e.preventDefault();
      reset();
      const files = Array.from(e.dataTransfer.files);
      if (files[0]) onFile(files[0], files.length - 1);
    },
  };

  return { active, bind };
}
