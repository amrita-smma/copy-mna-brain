"use client";

import { useChatActions } from "@/components/chat/ChatProvider";
import { useLayoutControl } from "@/components/layout/LayoutControlContext";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWorkspaceHref } from "@/hooks/useWorkspaceHref";
import {
  getSuggestedQuestions,
  type SuggestedQuestion,
  type SuggestedQuestionsResult,
} from "@/lib/api/crmSuggestedQuestions";
import { cn } from "@/lib/utils";
import { ArrowRight, Lock, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "Ask Brain" click behaviour: put the question in the chat composer WITHOUT
 * sending it, surface the copilot (desktop: reveal the docked pane; mobile:
 * the full-screen chat route) and leave the caret in the composer.
 */
export function useAskBrain(): (text: string) => void {
  const { prefillComposer, focusComposer } = useChatActions();
  const { focusCopilot } = useLayoutControl();
  const isMobile = useIsMobile();
  const router = useRouter();
  const chatHref = useWorkspaceHref("/chat");

  return useCallback(
    (text: string) => {
      // "Other" / "Ask something else" pass "": open the composer without
      // wiping a draft the user may already have in it.
      if (text) prefillComposer(text);
      if (isMobile) router.push(chatHref);
      else focusCopilot();
      focusComposer();
    },
    [prefillComposer, focusComposer, focusCopilot, isMobile, router, chatHref],
  );
}

/**
 * "Connect email" for a user without their own sync. There is no self-serve
 * sync flow: a workspace admin turns it on, so the link explains where.
 */
function ConnectEmail() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="ask-brain-connect-email"
          className="h-7 px-1 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Connect email for personalized questions
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 text-sm">
        <p>Email sync is turned on by a workspace admin in the Admin Portal.</p>
        <Link
          href="/admin-portal"
          className="inline-block font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="ask-brain-connect-email-admin-link"
        >
          Open Admin Portal
        </Link>
      </PopoverContent>
    </Popover>
  );
}

/** Question tiles before "Other": 2 personalized + 2 generic, or 4 generic. */
const TILE_COUNT = 4;
const PERSONALIZED_TILES = 2;

/** One question tile; "Other" passes "" and opens the composer empty. */
function AskBrainTile({
  label,
  hint,
  onClick,
  testId,
  kind,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  testId: string;
  kind: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      data-testid={testId}
      data-kind={kind}
      className={cn(
        "flex min-h-11 items-center justify-between gap-2.5 rounded-[10px] border bg-card px-3.5 py-2.5 text-left text-[13px] font-medium leading-snug text-foreground shadow-sm",
        "transition-[border-color,box-shadow,transform,color] hover:-translate-y-px hover:border-primary/40 hover:text-primary hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span className="line-clamp-2">{label}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

/**
 * The CRM page's "Ask Brain Bot" card (MB-861, prototype v2.4): today's
 * suggested questions for the signed-in user as tiles, plus "Other". A click
 * fills the chat composer and never sends.
 */
export function AskBrainRow({ userId }: { userId: string | null }) {
  const ask = useAskBrain();
  const [data, setData] = useState<SuggestedQuestionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!userId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    getSuggestedQuestions()
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setData(result);
        setFailed(false);
      })
      .catch(() => {
        if (requestRef.current === requestId) setFailed(true);
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
    return () => {
      requestRef.current += 1;
    };
  }, [userId]);

  const personalized = data?.personalized ?? [];
  const generic = data?.generic ?? [];
  const mine = personalized.slice(0, PERSONALIZED_TILES);
  const tiles: SuggestedQuestion[] = [
    ...mine,
    ...generic.slice(0, TILE_COUNT - mine.length),
  ];
  // Generic only, without the user's own sync: nothing personalized was ever
  // saved for them (the server keeps the last saved ones once sync is off).
  const showConnect = !!data && personalized.length === 0 && !data.hasSync;

  return (
    <section
      className="flex flex-col gap-3.5 rounded-[14px] border border-primary/20 bg-[color-mix(in_oklab,hsl(var(--primary))_4%,hsl(var(--card)))] px-5 py-[18px] shadow-sm"
      data-testid="ask-brain-row"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-sm">
          <Sparkles className="h-4 w-4" aria-hidden />
        </span>
        <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-bold text-foreground">Ask Brain Bot</h2>
            <span className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-px text-xs font-semibold text-muted-foreground">
              <Lock className="h-2.5 w-2.5" aria-hidden />
              Personal &amp; private
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Ask about contacts, relationships and past conversations
          </p>
        </div>
      </div>

      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-5"
        data-testid="ask-brain-chips"
      >
        {loading && !data ? (
          Array.from({ length: TILE_COUNT + 1 }, (_, i) => (
            <span
              key={i}
              aria-hidden
              data-testid="ask-brain-placeholder"
              className="h-11 animate-pulse rounded-[10px] bg-muted"
            />
          ))
        ) : (
          <>
            {failed && !data ? (
              <span className="col-span-full flex min-h-11 items-center text-xs text-muted-foreground lg:col-span-4">
                Suggestions unavailable right now
              </span>
            ) : (
              tiles.map((q, i) => (
                <AskBrainTile
                  key={`${q.kind}-${i}`}
                  label={q.text}
                  hint={i < mine.length ? "Personalised for you" : "Suggested"}
                  kind={q.kind}
                  onClick={() => ask(q.text)}
                  testId={`ask-brain-chip-${q.kind}`}
                />
              ))
            )}
            <AskBrainTile
              label="Other"
              hint="Ask your own question"
              kind="other"
              onClick={() => ask("")}
              testId="ask-brain-chip-other"
            />
          </>
        )}
      </div>

      {showConnect && (
        <div className="-mt-1">
          <ConnectEmail />
        </div>
      )}
    </section>
  );
}
