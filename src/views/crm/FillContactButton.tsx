"use client";

import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** `ai_workforce_queue` row shape the enrich endpoint returns. */
export interface EnrichmentRun {
  runId: string;
  status: string;
  active: boolean;
  error: string | null;
  /** Which button owns the run — see `ContactProfileCell`. */
  mode?: "fill" | "refresh";
}

/** How often to ask whether the run has finished. */
const POLL_MS = 4_000;
/**
 * Stop polling after this long. The queue's own reaper fails a stuck row at 30
 * minutes, but a CRM card left open for half an hour polling in the background
 * is not worth the requests — the AI Workforce page is where a long run is
 * meant to be watched, and the toast below says so.
 */
const POLL_TIMEOUT_MS = 5 * 60_000;

/**
 * "Get Full Profile" — queues an @crm_contact AI Workforce run for one
 * contact and watches it to completion.
 *
 * Sits in the contact's Profile cell rather than inside the edit dialog because
 * it is the answer to the thing you notice while *looking* at a half-empty
 * row: no title, no desk, no LinkedIn. Opening an editor to ask a machine to
 * fill it in would be a step backwards.
 *
 * The run itself lives on the AI Workforce queue, so nothing here owns it:
 * this component polls, and if the user navigates away mid-run the work
 * continues and the contact updates anyway.
 *
 * It does **not** look up its own starting state. The contacts tab loads every
 * row's latest run in one request and passes it down as `initialRun` — a GET
 * per rendered row would be exactly the client-side fan-out the N+1 rule
 * bans. A row handed an in-flight run resumes watching it, so a reload during
 * a run shows the spinner rather than offering to start a second one.
 *
 * With `refresh` it is the "Refresh" control on a profile that is already
 * filled: same run and polling, but the request asks the agent to research
 * the person again and rewrite the bio rather than only fill gaps.
 */
export function FillContactButton({
  correspondentId,
  contactName,
  initialRun,
  onFilled,
  refresh = false,
}: {
  correspondentId: string;
  contactName: string;
  /** This contact's latest run, from the tab's batched lookup. */
  initialRun?: EnrichmentRun | null;
  /** Called once a run succeeds, so the parent can refetch the contact. */
  onFilled: () => void;
  /** Re-research a filled profile instead of filling an empty one. */
  refresh?: boolean;
}) {
  const [running, setRunning] = useState(() => Boolean(initialRun?.active));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  /**
   * Bumped by every `startPolling`. A loop whose generation is stale returns
   * without touching state, so two loops can never both reach `finish` — the
   * duplicate toast and double `onFilled()` that a click racing a
   * late-arriving `initialRun` would otherwise produce.
   */
  const pollGenRef = useRef(0);
  /** The run this component has already begun watching, so a re-render with
   *  the same `initialRun` does not restart the loop. */
  const watchedRunIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    pollGenRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const finish = useCallback(
    (run: EnrichmentRun) => {
      stopPolling();
      setRunning(false);
      if (run.status === "succeeded") {
        toast.success(
          refresh ? `Refreshed ${contactName}'s profile` : `Updated ${contactName} from the web`,
        );
        onFilled();
        return;
      }
      toast.error(
        run.error || `Could not fill ${contactName} — see the AI Workforce page`,
      );
    },
    [contactName, onFilled, refresh, stopPolling],
  );

  const startPolling = useCallback(
    (runId: string) => {
      // Supersede whatever loop is running before opening a new one, so the
      // old one's generation check retires it instead of leaving an orphaned
      // timer behind.
      stopPolling();
      watchedRunIdRef.current = runId;
      const gen = pollGenRef.current;
      const deadline = Date.now() + POLL_TIMEOUT_MS;

      const poll = async (): Promise<void> => {
        try {
          const res = await fetch(
            `/api/crm/correspondents/${correspondentId}/enrich`,
            { credentials: "same-origin" },
          );
          if (!res.ok) throw new Error("poll failed");
          const { data } = (await res.json()) as { data: EnrichmentRun | null };
          if (!mountedRef.current || gen !== pollGenRef.current) return;
          if (!data) {
            stopPolling();
            setRunning(false);
            return;
          }
          if (!data.active) {
            finish(data);
            return;
          }
        } catch {
          // A single failed poll says nothing about the run — it is still on
          // the queue. Keep waiting; the deadline below is what ends this.
          if (!mountedRef.current || gen !== pollGenRef.current) return;
        }
        if (Date.now() > deadline) {
          stopPolling();
          setRunning(false);
          toast.info(
            `Still researching ${contactName} — follow it on the AI Workforce page`,
          );
          return;
        }
        // Re-checked rather than assumed: only the current generation is
        // allowed to own timerRef, so a superseded loop can never schedule a
        // tick that outlives the stopPolling() that retired it.
        if (gen !== pollGenRef.current) return;
        timerRef.current = setTimeout(() => void poll(), POLL_MS);
      };

      void poll();
    },
    [contactName, correspondentId, finish, stopPolling],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  // Resume a run that was already in flight when the tab loaded — a reload, or
  // a colleague's run on the same contact. `initialRun` arrives after mount
  // (the tab fetches it), hence an effect rather than the initial state alone.
  const initialRunId = initialRun?.active ? initialRun.runId : null;
  useEffect(() => {
    if (!initialRunId || watchedRunIdRef.current === initialRunId) return;
    setRunning(true);
    startPolling(initialRunId);
  }, [initialRunId, startPolling]);

  const start = async () => {
    setRunning(true);
    try {
      const res = await fetch(
        `/api/crm/correspondents/${correspondentId}/enrich`,
        {
          method: "POST",
          credentials: "same-origin",
          ...(refresh && {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refresh: true }),
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        data?: EnrichmentRun & { created: boolean };
        error?: string;
      };
      if (!res.ok || !body.data) {
        throw new Error(body.error || "Could not start the lookup");
      }
      toast.info(
        body.data.created
          ? refresh
            ? `Refreshing ${contactName}'s profile…`
            : `Looking up ${contactName} on the web…`
          : `Already looking up ${contactName}…`,
      );
      if (!body.data.active) {
        finish(body.data);
        return;
      }
      startPolling(body.data.runId);
    } catch (err) {
      setRunning(false);
      toast.error((err as Error).message);
    }
  };

  const firstName = contactName.trim().split(/\s+/)[0] || contactName;
  const busyLabel = refresh
    ? `Refreshing ${firstName}'s profile…`
    : `Getting ${firstName}'s profile…`;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 gap-1.5 self-start px-2 text-xs font-semibold text-primary hover:bg-primary/10 hover:text-primary disabled:opacity-70"
      onClick={() => void start()}
      disabled={running}
      aria-label={
        running
          ? busyLabel
          : refresh
            ? `Refresh ${contactName}'s profile`
            : `Get ${contactName}'s full profile`
      }
      title={
        running
          ? busyLabel
          : refresh
            ? "Research this contact again and rewrite the bio"
            : "Use AI to build this contact's full profile"
      }
      data-testid={refresh ? "contact-profile-refresh" : "contact-profile-get-full-profile"}
    >
      {running ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span>{busyLabel}</span>
        </>
      ) : refresh ? (
        <>
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh</span>
        </>
      ) : (
        <>
          <Sparkles className="h-3.5 w-3.5" />
          <span>Get Full Profile</span>
        </>
      )}
    </Button>
  );
}
