'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  DEFAULT_PIPELINE_HEADING,
  type PipelineHeading,
} from '@/lib/pipeline/heading';

interface PipelineHeadingContextValue {
  heading: PipelineHeading;
  /** Paint a heading the user just saved, without a refetch or a reload. */
  setHeading: (heading: PipelineHeading) => void;
}

// Carries the workspace's pipeline heading to the client. Seeded once by the
// /w/[workspaceSlug] layout from the workspace row it already fetched (no extra
// query), so the page renders the custom copy on first paint instead of
// flashing the default. Held as state rather than a bare prop so the edit
// dialog's save can update the header in place.
const PipelineHeadingContext = createContext<PipelineHeadingContextValue>({
  heading: DEFAULT_PIPELINE_HEADING,
  setHeading: () => {},
});

export function PipelineHeadingProvider({
  heading,
  children,
}: {
  heading: PipelineHeading;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState(heading);
  return (
    <PipelineHeadingContext.Provider value={{ heading: current, setHeading: setCurrent }}>
      {children}
    </PipelineHeadingContext.Provider>
  );
}

export function usePipelineHeading(): PipelineHeadingContextValue {
  return useContext(PipelineHeadingContext);
}
