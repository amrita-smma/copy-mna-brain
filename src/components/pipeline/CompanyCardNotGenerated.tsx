"use client";

import Link from "next/link";
import { ExternalLink, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CompanyCardNotGeneratedProps {
  /** A card run is queued or executing on the AI Workforce. */
  generating: boolean;
  /** The run's AI Workforce task page; null until the run id is known. */
  taskHref: string | null;
  onGenerate: () => void;
  onCancel?: () => void;
  cancelling?: boolean;
}

/**
 * The Overview tab before a company has an AI Company Card: a blank screen with
 * a single call to action instead of an empty slide. Once pressed it becomes
 * "Generating…" with a link to the AI Workforce task, and stays that way —
 * across reloads — for as long as the run is in flight.
 */
export function CompanyCardNotGenerated({
  generating,
  taskHref,
  onGenerate,
  onCancel,
  cancelling = false,
}: CompanyCardNotGeneratedProps) {
  return (
    <div
      className="flex min-h-[50vh] flex-col items-center justify-center gap-3 py-12"
      data-testid="company-card-not-generated"
    >
      {generating ? (
        <>
          <Button size="lg" className="gap-2" disabled data-testid="company-card-generating">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating...
          </Button>
          <div className="flex items-center gap-3 text-sm">
            {taskHref && (
              <Link
                href={taskHref}
                className="inline-flex items-center gap-1 text-accent hover:underline"
                data-testid="company-card-view-task"
              >
                View task in AI Workforce
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
            {onCancel && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-muted-foreground"
                onClick={onCancel}
                disabled={cancelling}
              >
                {cancelling ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Cancel
              </Button>
            )}
          </div>
        </>
      ) : (
        <Button
          size="lg"
          className="gap-2"
          onClick={onGenerate}
          data-testid="company-card-generate"
        >
          <Sparkles className="h-4 w-4" />
          Company card not generated, press here to generate
        </Button>
      )}
    </div>
  );
}
