import { CheckCircle2, HelpCircle, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trackPassRuleFromRows, trackScreeningVerdict } from "@/lib/screening/verdict";

export interface PrePipelineScreening {
  id: string;
  company_id: string;
  criteria_id: string;
  track_id: string | null;
  state: "pending" | "completed" | "failed";
  result: string | null;
  remarks: string | null;
  created_at: string;
  criterias: {
    id: string;
    name: string;
    prompt: string;
    must_pass?: boolean;
  } | null;
  track?: {
    id: string;
    title: string | null;
    min_optional_criteria_pass?: number | null;
  } | null;
}

type OverallScreeningStatus = "pending" | "pass" | "fail" | "inconclusive";

/**
 * Aggregate verdict for one track's screenings, under that track's rule
 * (must-pass criteria + minimum optional passes) — the same rule the AI
 * Screening panel and auto drop/promote use (src/lib/screening/verdict.ts).
 */
export function overallScreeningStatus(list: PrePipelineScreening[]): OverallScreeningStatus {
  if (list.some((s) => s.state === "pending")) return "pending";
  return trackScreeningVerdict(list, trackPassRuleFromRows(list));
}

interface ScreeningTrackGroup {
  key: string;
  trackName: string | null;
  screenings: PrePipelineScreening[];
}

/** Group a company's screenings by the track they were run for, order preserved. */
export function groupScreeningsByTrack(screenings: PrePipelineScreening[]): ScreeningTrackGroup[] {
  const groups = new Map<string, ScreeningTrackGroup>();
  for (const s of screenings) {
    const key = s.track_id ?? "none";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        trackName: s.track?.title?.trim() || null,
        screenings: [],
      });
    }
    groups.get(key)!.screenings.push(s);
  }
  return Array.from(groups.values());
}

function OverallStatusBadge({ status }: { status: OverallScreeningStatus }) {
  if (status === "pending") return <Badge variant="secondary">Pending</Badge>;
  if (status === "pass") return <Badge variant="default">Pass</Badge>;
  if (status === "fail") return <Badge variant="destructive">Fail</Badge>;
  return (
    <Badge
      variant="secondary"
      className="bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400"
    >
      Inconclusive
    </Badge>
  );
}

function ScreeningStateIcon({
  state,
  result,
}: {
  state: "pending" | "completed" | "failed";
  result: string | null;
}) {
  if (state === "pending") {
    return (
      <div className="flex items-center gap-1 text-yellow-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm font-medium">Pending</span>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="flex items-center gap-1 text-red-600">
        <XCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Failed</span>
      </div>
    );
  }

  const resultLower = result?.toLowerCase();

  if (resultLower === "inconclusive") {
    return (
      <div className="flex items-center gap-1 text-amber-500">
        <HelpCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Inconclusive</span>
      </div>
    );
  }

  const isPassed = resultLower === "pass" || resultLower === "yes";
  return (
    <div
      className={`flex items-center gap-1 ${isPassed ? "text-green-600" : "text-red-600"}`}
    >
      {isPassed ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <XCircle className="h-4 w-4" />
      )}
      <span className="text-sm font-medium">{isPassed ? "Pass" : "Fail"}</span>
    </div>
  );
}

/**
 * The company card's "Pre-pipeline Filters" tab body, shared by the detail
 * dialog and the detail page. One card per track, each with its own Overall
 * Status under that track's pass rule, so it always agrees with the AI
 * Screening panel.
 */
export function PrePipelineFilterResults({
  screenings,
}: {
  screenings: PrePipelineScreening[];
}) {
  if (screenings.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pre-pipeline Filter Results</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No screenings have been run yet. Use Scan now, or Run AI Screening
            on the company in Pending Confirmation.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {groupScreeningsByTrack(screenings).map((group) => (
        <Card key={group.key}>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              Pre-pipeline Filter Results
              <Badge variant="secondary" className="font-normal align-middle">
                {group.trackName || "Unassigned"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {group.screenings.map((screening) => (
                <div
                  key={screening.id}
                  className="flex items-center justify-between py-2 border-b last:border-0"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {screening.criterias?.name || "Unknown Criteria"}
                      </span>
                      {screening.criterias?.must_pass && (
                        <Badge variant="secondary" className="text-xs">
                          Must-pass
                        </Badge>
                      )}
                      <Badge
                        variant={
                          screening.state === "completed"
                            ? "outline"
                            : screening.state === "pending"
                              ? "secondary"
                              : "destructive"
                        }
                        className="text-xs"
                      >
                        {screening.state}
                      </Badge>
                    </div>
                    {screening.result && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {screening.result}
                      </p>
                    )}
                    {screening.remarks && (
                      <p className="text-xs text-muted-foreground mt-1 italic">
                        {screening.remarks}
                      </p>
                    )}
                  </div>
                  <ScreeningStateIcon
                    state={screening.state}
                    result={screening.result}
                  />
                </div>
              ))}
              <div className="pt-3 border-t">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Overall Status</span>
                  <OverallStatusBadge
                    status={overallScreeningStatus(group.screenings)}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
