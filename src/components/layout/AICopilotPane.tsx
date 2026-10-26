'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { ChevronLeft, Maximize2, Minimize2, Send, Square, Loader2 } from 'lucide-react';
import posthog from 'posthog-js';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { LiquidGlass, LiquidGlassButton } from '@/components/ui/liquid-glass';
import { cn } from '@/lib/utils';
import {
  useChatActions,
  useChatComposer,
  useChatContext,
  useChatStatus,
  useChatThread,
} from '@/components/chat/ChatProvider';
import { ChatTextarea } from '@/components/chat/ChatTextarea';
import {
  AttachButton,
  AttachmentChips,
  useAttachmentDrop,
  useAttachmentPaste,
} from '@/components/chat/ChatComposerAttachments';
import { InsightContextButton } from '@/components/chat/InsightContextButton';
import { ChatMessageBubble, LoadingBubble } from '@/components/chat/ChatMessageBubble';
import { BotRelayGroup } from '@/components/chat/BotRelayGroup';
import { dayLabel, dayStarts, messageCreatedAt } from '@/lib/chat/messageTime';
import { groupRelayMessages } from '@/lib/chat/relayGroups';
import { retryQuestionTexts } from '@/lib/chat/responseFeedback';
import { ChatSuggestionsCarousel } from '@/components/chat/ChatSuggestions';
import { InsightTemplatePopup } from '@/components/chat/InsightTemplatePopup';
import { BotMentionPopup } from '@/components/chat/BotMentionPopup';
import {
  filterMentionCandidates,
  isCompletedMention,
  mentionInsertAt,
  mentionQueryAt,
} from '@/lib/bots/mentions';
import type { BotDto } from '@/lib/bots/types';
import type { BotPhase } from '@/lib/bots/presenceTypes';
import { InsightTemplateChip } from '@/components/chat/InsightTemplateChip';
import { OPTIONS } from '@/components/chat/EffortSelector';
import {
  stripSlashCommand,
  resolveSlashCommandState,
  filterSlashCommands,
  completeSlashCommand,
  type SlashCommandDefinition,
} from '@/lib/chat/slashCommand';
import {
  INSIGHT_TEMPLATE_TRIGGER,
  INSIGHT_TEMPLATE_COMMAND,
  filterInsightTemplates,
  sortTemplatesByRecency,
} from '@/lib/insights/insightSlashCommand';
import { listInsightTemplates, type InsightTemplateSummary } from '@/lib/api/insightTemplates';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { motion, AnimatePresence } from 'framer-motion';
import { BotAvatar } from '@/components/bots/BotAvatar';
import { isRespondingState, ThoughtCloud } from '@/components/bots/ThoughtCloud';
import { BotStrip } from '@/components/bots/BotStrip';
import { BotEditDialog } from '@/components/bots/BotEditDialog';
import { setComposerHasText, useBotAvatarState } from '@/components/bots/useBotAvatarState';

function ScrollContent({
  children,
  floating = false,
  topInset = 0,
  bottomInset = 0,
}: {
  children: React.ReactNode;
  /** The header and composer float over the transcript, so it runs the full
   *  height of the pane and pads itself clear of them (both measured). */
  floating?: boolean;
  /** The floating header's height, so the first message clears it. */
  topInset?: number;
  /** The floating composer's height, so the last message clears it. */
  bottomInset?: number;
}) {
  const context = useStickToBottomContext();

  return (
    <div
      ref={context.scrollRef}
      className={cn('overflow-y-auto min-h-0', floating ? 'absolute inset-0 overscroll-contain' : 'flex-1')}
    >
      <div
        ref={context.contentRef}
        className="p-4"
        style={floating ? { paddingTop: topInset + 8, paddingBottom: bottomInset + 16 } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

// How long the user must be idle (no typing) before the "… Enhance"
// affordance appears next to the composer.
const ENHANCE_IDLE_MS = 1250;

// Per-browser memory of the last insight template used, so the
// `/insight-template` popup can surface it first. Best-effort — private
// browsing / storage-disabled environments just fall back to API order.
const LAST_INSIGHT_TEMPLATE_KEY = 'mna-brain:lastInsightTemplateId';

function readLastInsightTemplateId(): string | null {
  try {
    return typeof window !== 'undefined'
      ? window.localStorage.getItem(LAST_INSIGHT_TEMPLATE_KEY)
      : null;
  } catch {
    return null;
  }
}

function writeLastInsightTemplateId(id: string) {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LAST_INSIGHT_TEMPLATE_KEY, id);
    }
  } catch {
    // Ignore — recency sort just won't persist this session.
  }
}

// The composer's slash-command palette. A second command later just adds its
// own entry here (and its own content branch in `InsightTemplatePopup`).
const SLASH_COMMANDS: SlashCommandDefinition[] = [INSIGHT_TEMPLATE_COMMAND];

/**
 * The composer at the bottom of the transcript — a floating sheet of glass
 * over it, or the classic docked bar — with the starting-point carousel
 * above the box.
 */
function ChatInput({
  isExpanded,
  floating = false,
  showSuggestions = false,
}: {
  isExpanded: boolean;
  /** A liquid-glass composer floating over the bottom of the transcript
   *  (every chat, desktop and mobile), clear of the home indicator. */
  floating?: boolean;
  /** The starting-point carousel above the box (once the thread's history is in). */
  showSuggestions?: boolean;
}) {
  const [input, setInput] = useState('');
  const [showEnhance, setShowEnhance] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when an enhancement succeeds so we can re-focus the textarea only
  // after it re-enables (focusing while still disabled is a no-op).
  const refocusAfterEnhanceRef = useRef(false);
  const {
    sendText,
    stop,
    chatInputRef,
    focusComposer,
    setInsightTemplate,
  } = useChatActions();
  const { attachments, composerDraft, insightTemplate } = useChatComposer();
  const { bots, activeBot } = useChatThread();
  const { status } = useChatStatus();
  const { onPaste } = useAttachmentPaste();
  // Only a turn in progress locks the composer: this tab's own, or one the
  // bot is running elsewhere (`busy` is its live phase).
  const isBusy = status === 'streaming' || status === 'submitted' || (status === 'ready' && !!activeBot?.busy);
  const hasReadyAttachment = attachments.some((a) => a.status === 'ready');

  // When an external trigger (e.g. "New insight") stages a draft, prefill the
  // input and put the caret at the end. Keyed on nonce so identical prompts
  // can be triggered consecutively without no-oping; the draft is
  // deliberately not cleared here to prevent React Strict Mode's
  // double-invoke from wiping it.
  const draftNonce = composerDraft?.nonce;
  const draftText = composerDraft?.text;
  useEffect(() => {
    if (draftNonce == null || draftText == null) return;
    setInput(draftText);
    focusComposer();
  }, [draftNonce, draftText, focusComposer]);

  // Slash-command palette + per-command content: detection, template
  // fetch/cache, and keyboard-driven highlight. All state lives here so the
  // popup and the keyboard handler below share one source of truth.
  const [insightTemplates, setInsightTemplates] = useState<InsightTemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesFetched, setTemplatesFetched] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [popupDismissed, setPopupDismissed] = useState(false);

  const slashState = resolveSlashCommandState(input, SLASH_COMMANDS);
  const popupOpen = slashState.stage !== 'closed' && !insightTemplate && !popupDismissed;
  const isInsightTemplateCommand =
    slashState.stage === 'command' && slashState.command.trigger === INSIGHT_TEMPLATE_TRIGGER;
  const activeQuery = slashState.stage === 'closed' ? '' : slashState.query;

  useEffect(() => {
    setPopupDismissed(false);
  }, [slashState.stage]);

  useEffect(() => {
    if (!isInsightTemplateCommand || templatesFetched) return;
    setTemplatesLoading(true);
    listInsightTemplates()
      .then((data) => {
        setInsightTemplates(data);
        setTemplatesFetched(true);
      })
      .catch((err: unknown) => {
        console.error('[copilot] failed to load insight templates:', err);
      })
      .finally(() => setTemplatesLoading(false));
  }, [isInsightTemplateCommand, templatesFetched]);

  const paletteCommands =
    slashState.stage === 'palette' ? filterSlashCommands(SLASH_COMMANDS, slashState.query) : [];

  const filteredTemplates = (() => {
    if (!isInsightTemplateCommand) return [];
    const byQuery = filterInsightTemplates(insightTemplates, activeQuery);
    return activeQuery.trim()
      ? byQuery
      : sortTemplatesByRecency(byQuery, readLastInsightTemplateId());
  })();

  useEffect(() => {
    setHighlightedIndex(0);
  }, [slashState.stage, activeQuery]);

  // The `@` autocomplete: the mention being typed at the caret, re-read on
  // every edit and caret move.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  // A picked (or fully typed) "@Name " is finished, so the list stays shut
  // when the caret lands after it. The picked one is remembered too, so
  // picking "Deal" does not reopen the list on "Deal Scout".
  const [pickedMention, setPickedMention] = useState<{ start: number; query: string } | null>(null);
  const mentionable = bots.filter((b) => b.id !== activeBot?.id);
  const mentionFinished =
    !!mention &&
    ((pickedMention?.start === mention.start &&
      pickedMention.query === mention.query &&
      mentionInsertAt(input, pickedMention.start, pickedMention.query)) ||
      isCompletedMention(mentionable, mention.query));
  const mentionCandidates =
    mention && !mentionFinished ? filterMentionCandidates(mentionable, mention.query) : [];
  const mentionOpen = mentionCandidates.length > 0 && !popupOpen && !mentionDismissed;
  const readMention = (el: HTMLTextAreaElement) =>
    setMention(mentionQueryAt(el.value, el.selectionStart ?? el.value.length));
  const mentionStart = mention?.start;
  const mentionQuery = mention?.query;
  useEffect(() => {
    setMentionDismissed(false);
  }, [mentionStart]);
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  useEffect(() => {
    if (
      pickedMention &&
      !mentionInsertAt(input, pickedMention.start, pickedMention.query)
    ) {
      setPickedMention(null);
    }
  }, [input, pickedMention]);

  const handleSelectMention = (bot: BotDto) => {
    const el = chatInputRef.current;
    if (!mention || !el) return;
    const caret = el.selectionStart ?? input.length;
    const inserted = `@${bot.name} `;
    setInput(input.slice(0, mention.start) + inserted + input.slice(caret));
    setMention(null);
    setPickedMention({ start: mention.start, query: inserted.slice(1) });
    const pos = mention.start + inserted.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const handleSelectTemplate = useCallback(
    (tpl: InsightTemplateSummary) => {
      setInsightTemplate({ id: tpl.id, name: tpl.name });
      writeLastInsightTemplateId(tpl.id);
      setInput((prev) => stripSlashCommand(prev, INSIGHT_TEMPLATE_TRIGGER));
      setPopupDismissed(false);
      // The slash-command text (and any query typed to filter it) is gone
      // from the box now, so any pending/shown "… enhance" affordance for
      // that now-vanished text must go with it — otherwise it renders on top
      // of the fresh placeholder.
      clearIdleTimer();
      setShowEnhance(false);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    },
    [setInsightTemplate, chatInputRef, clearIdleTimer],
  );

  // A palette row was chosen: complete the partial "/…" text to that
  // command's full trigger and let it flow straight into that command's own
  // content (resolved fresh on the next render from the completed input).
  const handleSelectCommand = useCallback(
    (command: SlashCommandDefinition) => {
      setInput((prev) => completeSlashCommand(prev, command.trigger));
      setHighlightedIndex(0);
      requestAnimationFrame(() => chatInputRef.current?.focus());
    },
    [chatInputRef],
  );

  // Restart the idle countdown on every keystroke: hide the affordance now, and
  // re-show it only after ENHANCE_IDLE_MS of no typing — provided there's text
  // to improve and the agent isn't mid-response.
  const scheduleIdleCheck = useCallback(
    (text: string) => {
      clearIdleTimer();
      setShowEnhance(false);
      if (!text.trim() || isBusy) return;
      idleTimerRef.current = setTimeout(() => setShowEnhance(true), ENHANCE_IDLE_MS);
    },
    [clearIdleTimer, isBusy],
  );

  // While the agent is responding there's nothing to enhance — cancel any
  // pending countdown and hide the affordance.
  useEffect(() => {
    if (isBusy) {
      clearIdleTimer();
      setShowEnhance(false);
    }
  }, [isBusy, clearIdleTimer]);

  useEffect(() => () => clearIdleTimer(), [clearIdleTimer]);

  // After an enhancement completes the textarea re-enables; return focus to it
  // and move the caret to the end of the (now replaced) text so the user can
  // keep typing straight away.
  useEffect(() => {
    if (isEnhancing || !refocusAfterEnhanceRef.current) return;
    refocusAfterEnhanceRef.current = false;
    const el = chatInputRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [isEnhancing, chatInputRef]);

  // The bot avatar leans in while there is an unsent draft.
  const hasDraft = input.trim().length > 0;
  useEffect(() => {
    setComposerHasText(hasDraft);
  }, [hasDraft]);
  useEffect(() => () => setComposerHasText(false), []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setInput(next);
    readMention(e.target);
    scheduleIdleCheck(next);
  };

  const handleSubmit = () => {
    if (isBusy) return;
    if (!input.trim() && !hasReadyAttachment) return;
    // Attachment-only send still needs a real user turn — fall back to a
    // default prompt so the model has an instruction to act on.
    const rawText = input.trim() ? input : 'Please review the attached file(s).';
    sendText(rawText, insightTemplate ?? undefined);
    setInput('');
    setMention(null);
    setPickedMention(null);
    setInsightTemplate(null);
    clearIdleTimer();
    setShowEnhance(false);
  };

  // Ask the agent to rewrite the current draft into a clearer prompt, then
  // replace the whole input with the result. Triggered by clicking "… Enhance"
  // or pressing Shift+Tab.
  const handleEnhance = useCallback(async (trigger: 'click' | 'shortcut') => {
    const current = input.trim();
    if (!current || isEnhancing || isBusy) return;
    clearIdleTimer();
    setShowEnhance(false);
    setIsEnhancing(true);
    try {
      const res = await fetch('/api/chat/improve-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: current }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json();
      const improved: string | undefined = data?.improved;
      if (!improved) throw new Error('No improved prompt returned');
      setInput(improved);
      // Defer the focus until the textarea re-enables (see the effect below).
      refocusAfterEnhanceRef.current = true;
      // Track enhancement usage. `changed` is false when the prompt was already
      // clear and the model kept it as-is, so we can tell useful rewrites apart.
      posthog.capture('copilot_prompt_enhanced', {
        trigger,
        original_length: current.length,
        improved_length: improved.length,
        changed: improved !== current,
      });
    } catch (err) {
      console.error('[copilot] prompt enhancement failed:', err);
      toast.error('Could not enhance the prompt — please try again.');
    } finally {
      setIsEnhancing(false);
    }
  }, [input, isEnhancing, isBusy, clearIdleTimer]);

  // Opening the mobile keyboard triggers layout shifts (visual-viewport resize,
  // bottom-nav hide) that can momentarily drop focus from the input. Re-assert
  // focus across the keyboard-animation window so the user can type right away —
  // but only when focus was dropped to nowhere, never stealing it from another
  // control the user deliberately tapped.
  const handleFocus = () => {
    const reassert = () => {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        chatInputRef.current?.focus();
      }
    };
    for (const delay of [50, 150, 300, 600]) {
      window.setTimeout(reassert, delay);
    }
  };

  return (
    <div
      className={cn(
        'shrink-0',
        floating ? 'px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2' : 'border-t bg-muted p-4',
      )}
    >
      <motion.div
        className="mx-auto"
        animate={{ maxWidth: isExpanded ? '95%' : '100%' }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          onPaste={onPaste}
        >
          {/* The × sits in the send button's column: the box pads by 0.375rem
              (floating) and the button is 2.25rem wide, so its centre is
              1.5rem in from the edge; a 1.75rem × with 0.625rem to its right
              is centred on the same line. */}
          {showSuggestions && <ChatSuggestionsCarousel className={cn('mb-2', floating ? 'pr-2.5' : 'pr-3')} />}
          <AttachmentChips className="mb-2" />
          {insightTemplate && (
            <div className="mb-2 flex">
              <InsightTemplateChip
                name={insightTemplate.name}
                onRemove={() => setInsightTemplate(null)}
              />
            </div>
          )}
          <InsightTemplatePopup
            open={popupOpen}
            stage={slashState.stage === 'palette' ? 'palette' : 'command'}
            paletteCommands={paletteCommands}
            loading={templatesLoading}
            hasAnyTemplates={insightTemplates.length > 0}
            filtered={filteredTemplates}
            highlightedIndex={highlightedIndex}
            onHighlightChange={setHighlightedIndex}
            onSelectCommand={handleSelectCommand}
            onSelectTemplate={handleSelectTemplate}
            onDismiss={() => setPopupDismissed(true)}
          >
          <BotMentionPopup
            open={mentionOpen}
            bots={mentionCandidates}
            highlightedIndex={mentionIndex}
            onHighlightChange={setMentionIndex}
            onSelect={handleSelectMention}
            onDismiss={() => setMentionDismissed(true)}
          >
          <div
            className={cn(
              'relative flex items-end gap-2 rounded-2xl border bg-background p-2',
              // A floating sheet of glass, the messages blurring past behind it.
              floating && 'liquid-glass rounded-[1.6rem] border-0 bg-transparent p-1.5 shadow-none',
            )}
          >

            <AttachButton disabled={isBusy} className="self-end" />
            {/* The textarea is absolutely positioned over an invisible in-flow
                "mirror" that carries the same text, box, padding and typography
                — plus the visible "... enhance" affordance. Because the mirror
                drives the wrapper's height, the box GROWS and the hint wraps
                onto its own line when the pane is narrow, instead of the hint
                being clipped. The mirror ignores pointer events except on the
                Enhance button, so typing/clicking still reaches the textarea. */}
            <div className="relative flex-1">
              <ChatTextarea
                ref={chatInputRef}
                value={input}
                onChange={handleChange}
                onSubmit={handleSubmit}
                onFocus={handleFocus}
                onSelect={(e) => readMention(e.currentTarget)}
                onKeyDown={(e) => {
                  // The @mention list takes the arrows, Enter/Tab and Esc
                  // while it is open.
                  if (mentionOpen && !e.nativeEvent.isComposing) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setMentionIndex((i) => Math.max(i - 1, 0));
                      return;
                    }
                    if ((e.key === 'Enter' || e.key === 'Tab') && mentionCandidates[mentionIndex]) {
                      e.preventDefault();
                      handleSelectMention(mentionCandidates[mentionIndex]);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setMentionDismissed(true);
                      return;
                    }
                  }
                  // While the insight-template popup is open, hijack
                  // navigation/selection keys instead of the textarea's own
                  // newline/submit behavior (ChatTextarea runs this handler
                  // before its own Enter-to-submit check and honors
                  // preventDefault()).
                  if (popupOpen && !e.nativeEvent.isComposing) {
                    const activeList =
                      slashState.stage === 'palette' ? paletteCommands : filteredTemplates;
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setHighlightedIndex((i) => Math.min(i + 1, activeList.length - 1));
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setHighlightedIndex((i) => Math.max(i - 1, 0));
                      return;
                    }
                    if ((e.key === 'Enter' || e.key === 'Tab') && activeList[highlightedIndex]) {
                      e.preventDefault();
                      if (slashState.stage === 'palette') {
                        handleSelectCommand(paletteCommands[highlightedIndex]);
                      } else {
                        handleSelectTemplate(filteredTemplates[highlightedIndex]);
                      }
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setPopupDismissed(true);
                      return;
                    }
                  }
                  // Shift+Tab enhances the draft instead of moving focus.
                  if (e.key === 'Tab' && e.shiftKey && input.trim() && !isEnhancing && !isBusy) {
                    e.preventDefault();
                    handleEnhance('shortcut');
                  }
                }}
                placeholder={
                  insightTemplate
                    ? `Add instructions for the "${insightTemplate.name}" insight…`
                    : 'Ask anything...'
                }
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                className="absolute inset-x-0 top-0 w-full text-sm border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled={isBusy || isEnhancing}
              />
              <div
                aria-hidden={!showEnhance}
                className="pointer-events-none relative z-10 max-h-[7.25rem] overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm leading-5 sm:max-h-[13.5rem]"
              >
                {/* Zero-width space keeps the box at one line tall when empty so
                    it matches the textarea's minimum height. */}
                <span className="invisible">{input}{'\u200b'}</span>
                {(showEnhance || isEnhancing) && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => handleEnhance('click')}
                      disabled={isEnhancing}
                      title="Improve this prompt (Shift+Tab)"
                      className="pointer-events-auto cursor-pointer text-xs font-normal text-blue-500 underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-70 dark:text-blue-400"
                    >
                      {isEnhancing ? 'enhancing…' : '... enhance'}
                    </button>
                  </>
                )}
              </div>
            </div>
            {isBusy ? (
              <Button
                type="button"
                size="sm"
                onClick={() => stop()}
                aria-label="Stop generating"
                title="Stop generating"
                className={cn('bg-red-600 hover:bg-red-700 shrink-0 rounded-xl', floating && 'h-9 w-9 rounded-full p-0')}
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!input.trim() && !hasReadyAttachment}
                aria-label="Send"
                className={cn('bg-blue-600 hover:bg-blue-700 shrink-0 rounded-xl', floating && 'h-9 w-9 rounded-full p-0')}
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
          </BotMentionPopup>
          </InsightTemplatePopup>
        </form>
      </motion.div>
    </div>
  );
}

/** The thinking bubble's text for a bot's live phase. */
function liveLabel(phase: BotPhase | undefined, answeringUser: boolean): string {
  switch (phase) {
    case 'working':
      return 'Working';
    case 'talking':
      return 'Writing';
    default:
      return answeringUser ? 'Responding' : 'Working in the background';
  }
}

/**
 * A bot's thread is permanent, so its history pages: opening a bot loads its
 * last few turns, and this loads the turns before them when the top of the
 * transcript scrolls into view, keeping what the user was reading in place.
 */
function LoadEarlierMessages() {
  const { hasEarlierMessages, isLoadingEarlier } = useChatThread();
  const { loadEarlierMessages } = useChatActions();
  const { scrollRef } = useStickToBottomContext();
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Distance from the bottom before an older page lands, restored after it.
  const fromBottomRef = useRef<number | null>(null);

  // Re-armed after each load, so a sentinel still in view (a short page)
  // loads the next page too.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!hasEarlierMessages || isLoadingEarlier || !sentinel || !root) return;
    let observer: IntersectionObserver | undefined;
    // Armed after the transcript has settled at the bottom on open, so the
    // top is not "in view" for the instant before that scroll.
    const arm = setTimeout(() => {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          observer?.disconnect();
          fromBottomRef.current = root.scrollHeight - root.scrollTop;
          void loadEarlierMessages().then((ok) => {
            if (!ok) fromBottomRef.current = null;
          });
        },
        { root, rootMargin: '300px 0px 0px 0px' },
      );
      observer.observe(sentinel);
    }, 300);
    return () => {
      clearTimeout(arm);
      observer?.disconnect();
    };
  }, [hasEarlierMessages, isLoadingEarlier, loadEarlierMessages, scrollRef]);

  // The older page is in the DOM: put the scroll back where the user was.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (isLoadingEarlier || fromBottomRef.current === null || !root) return;
    root.scrollTop = root.scrollHeight - fromBottomRef.current;
    fromBottomRef.current = null;
  }, [isLoadingEarlier, scrollRef]);

  if (!hasEarlierMessages) return null;
  return (
    <div
      ref={sentinelRef}
      className="flex h-8 items-center justify-center"
      data-testid="copilot-load-earlier"
      aria-hidden={!isLoadingEarlier}
    >
      {isLoadingEarlier && (
        <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading earlier messages…
        </span>
      )}
    </div>
  );
}

/** The mobile chat's title: back to the bot home, then the bot it is talking to. */
function MobileChatTitle({ onBack }: { onBack: () => void }) {
  const { activeBot } = useChatThread();
  const { refreshBots } = useChatActions();
  const { status, messages } = useChatContext();
  // The avatar in the title is live, with the same thought cloud the strip
  // shows on desktop: this tab's own turn, or a turn the bot runs elsewhere.
  const avatarState = useBotAvatarState(status, messages);
  const responding = isRespondingState(avatarState) || (!!activeBot?.busy && status === 'ready');
  // Tapping the name opens the bot's dialog (settings, memory, routines, task
  // log, archive) — the mobile stand-in for the Bots page's Edit.
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="mobile-chat-title">
      <LiquidGlassButton
        onClick={onBack}
        className="pointer-events-auto"
        aria-label="Back to bots"
        data-testid="mobile-chat-back"
      >
        <ChevronLeft className="!h-6 !w-6 -translate-x-px" />
      </LiquidGlassButton>
      {activeBot && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="pointer-events-auto min-w-0 rounded-full text-left"
          aria-label={`Open ${activeBot.name}'s settings`}
          data-testid="mobile-chat-bot"
        >
          <LiquidGlass className="flex h-11 min-w-0 items-center gap-2 rounded-full py-1 pl-1.5 pr-4">
            <span className="relative shrink-0">
              <BotAvatar avatar={activeBot.avatar} state={avatarState} size="sm" label={`${activeBot.name} avatar`} />
              <AnimatePresence>
                {responding && (
                  <ThoughtCloud key="cloud" className="-right-3 -top-2.5" label={`${activeBot.name} is responding`} />
                )}
              </AnimatePresence>
            </span>
            <span className="truncate text-[15px] font-semibold">{activeBot.name}</span>
          </LiquidGlass>
        </button>
      )}
      {activeBot && editing && (
        <BotEditDialog
          key={activeBot.id}
          bot={activeBot}
          open={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
          onSaved={() => {
            setEditing(false);
            void refreshBots();
          }}
          onArchived={() => {
            setEditing(false);
            void refreshBots();
            onBack();
          }}
          onOpenChat={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** The date above the first message of a day: a pill on a rule across the transcript. */
function DaySeparator({ date }: { date: Date }) {
  const label = dayLabel(date);
  return (
    <div role="separator" aria-label={label} data-testid="day-separator" className="my-1 flex items-center gap-3 px-2">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

function ChatContent({
  isExpanded,
  floating = false,
  topInset = 0,
}: {
  isExpanded: boolean;
  /** The header and composer float over the transcript (see `ScrollContent`). */
  floating?: boolean;
  /** The floating header's measured height. */
  topInset?: number;
}) {
  const { messages, status, activeBot } = useChatContext();
  const { livePhase, chatId, isLoadingMessages, messagesChatId } = useChatThread();
  const isStreaming = status === 'streaming';
  // The starting points ride above the composer in every thread, empty or
  // not — they are shortcuts, not a landing — once its history is in (not
  // while it loads, or the carousel would flash in before the messages).
  const showSuggestions = chatId !== null && !isLoadingMessages && messagesChatId === chatId;
  const liveAvatarState = useBotAvatarState(status, messages);
  // Other bots' messages (replies back, hand-offs) fold into one collapsed
  // row per run, since the bot relays what matters from them itself.
  const items = useMemo(() => groupRelayMessages(messages), [messages]);
  // Retry on a reply sends the question that started its turn again.
  const retryTexts = useMemo(() => retryQuestionTexts(messages), [messages]);
  const lastIndex = messages.length - 1;
  // A date between two messages written on different days.
  const days = useMemo(
    () => dayStarts(items, (item) => (item.kind === 'relay' ? item.messages : [item.message]).map(messageCreatedAt)),
    [items],
  );
  // The floating composer grows with its text; the transcript pads by its
  // measured height so the newest message never hides behind it.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useEffect(() => {
    const el = composerRef.current;
    if (!floating || !el) {
      setComposerHeight(0);
      return;
    }
    const sync = () => setComposerHeight(el.offsetHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [floating, messages.length]);

  // No separate landing for an empty thread: the same transcript, empty, so
  // the first messages render into it in place instead of swapping screens.
  return (
    <StickToBottom className={cn('flex-1 flex flex-col min-h-0', floating && 'relative')}>
      <ScrollContent floating={floating} topInset={topInset} bottomInset={composerHeight}>
        <motion.div
          className="flex flex-col gap-2"
          animate={{
            maxWidth: isExpanded ? '95%' : '100%',
            marginLeft: isExpanded ? 'auto' : 0,
            marginRight: isExpanded ? 'auto' : 0,
          }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
        >
          <LoadEarlierMessages />
          {items.map((item, i) => {
            const key = item.kind === 'relay' ? item.id : item.message.id;
            const day = days[i];
            return (
              <Fragment key={key}>
                {day && <DaySeparator date={day} />}
                {item.kind === 'relay' ? (
                  <BotRelayGroup messages={item.messages} senders={item.senders} label={item.label} />
                ) : (
                  <ChatMessageBubble
                    message={item.message}
                    isActive={isStreaming && item.index === messages.length - 1}
                    botAvatar={activeBot?.avatar}
                    botName={activeBot?.name}
                    avatarState={item.index === messages.length - 1 ? liveAvatarState : 'idle'}
                    showActions
                    retryText={retryTexts.get(item.index) ?? null}
                    isLatestReply={item.index === lastIndex && status === 'ready'}
                  />
                )}
              </Fragment>
            );
          })}
          {status === 'submitted' && (
            <LoadingBubble botAvatar={activeBot?.avatar} botName={activeBot?.name} />
          )}
          {/* The thread's turn is running on the server while this tab is not
              streaming it: the user left mid-reply and came back (the
              question ends the transcript), an @mention or a routine. The
              reply loads here when the events stream announces it; a bot
              waiting on another bot's answer is not running and shows no
              bubble. */}
          {status === 'ready' && activeBot?.busy && (
            <LoadingBubble
              botAvatar={activeBot.avatar}
              botName={activeBot.name}
              label={liveLabel(livePhase[activeBot.id], messages[messages.length - 1]?.role === 'user')}
            />
          )}
        </motion.div>
      </ScrollContent>
      {floating ? (
        <div ref={composerRef} className="absolute inset-x-0 bottom-0 z-10">
          {/* A fade under the glass, so text scrolling out reads as passing behind it. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-full bg-gradient-to-t from-background via-background/70 to-transparent" />
          <div className="relative">
            <ChatInput isExpanded={isExpanded} floating showSuggestions={showSuggestions} />
          </div>
        </div>
      ) : (
        <ChatInput isExpanded={isExpanded} showSuggestions={showSuggestions} />
      )}
    </StickToBottom>
  );
}

export const COPILOT_MIN_WIDTH = 320;
export const COPILOT_MAX_WIDTH = 720;
export const COPILOT_DEFAULT_WIDTH = 384;

interface AICopilotPaneProps {
  isExpanded: boolean;
  onToggleExpand: () => void;
  width?: number;
  onResize?: (width: number) => void;
  className?: string;
  /**
   * Hide the expand/collapse toggle. Used by the mobile layout, where the
   * copilot is always full-screen and there is nothing to expand into.
   */
  hideExpandToggle?: boolean;
  /**
   * Mobile: the chat is a full screen opened from the bot home. The header
   * shows a back button and the bot's avatar and name instead of the strip.
   */
  onBack?: () => void;
}

export function AICopilotPane({
  isExpanded,
  onToggleExpand,
  width = COPILOT_DEFAULT_WIDTH,
  onResize,
  className,
  hideExpandToggle = false,
  onBack,
}: AICopilotPaneProps) {
  const { setEffortChoice } = useChatActions();
  const { effortChoice } = useChatComposer();
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  // File drag-and-drop covers the entire pane, not just the composer — drop a
  // file anywhere on the copilot to attach it.
  const { isDragging: isFileDragging, dropHandlers } = useAttachmentDrop();
  // The header floats over the transcript, which runs the full height of the
  // pane behind a fade; the transcript pads by the header's measured height
  // so the first message clears it (the composer does the same at the bottom).
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const sync = () => setHeaderHeight(el.offsetHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (isExpanded || !onResize) return;
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: width };
      setIsDragging(true);
    },
    [isExpanded, onResize, width],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      // Pane is docked to the right edge, so dragging left widens it.
      const delta = dragState.current.startX - e.clientX;
      const next = Math.min(
        COPILOT_MAX_WIDTH,
        Math.max(COPILOT_MIN_WIDTH, dragState.current.startWidth + delta),
      );
      onResize?.(next);
    };
    const handleUp = () => {
      dragState.current = null;
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = '';
    };
  }, [isDragging, onResize]);

  return (
    <motion.div
      data-testid="copilot-pane"
      className={cn(
        'relative flex flex-col bg-background h-full top-0 overflow-hidden',
        // The left border separates the docked pane from the console. Expanded,
        // there is no console beside it to separate from.
        !isExpanded && 'border-l',
        className
      )}
      initial={false}
      animate={{
        width: isExpanded ? '100%' : width,
      }}
      transition={{
        duration: isDragging ? 0 : 0.3,
        ease: [0.4, 0, 0.2, 1],
      }}
      {...dropHandlers}
    >
      {isFileDragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10 text-sm font-medium text-blue-700 backdrop-blur-[1px]">
          Drop files to attach
        </div>
      )}
      {!isExpanded && onResize && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleResizeStart}
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize',
            'transition-colors hover:bg-blue-500/40',
            isDragging && 'bg-blue-500/60',
          )}
        />
      )}
      <motion.div
        ref={headerRef}
        className={cn(
          // The header floats over the transcript, which scrolls the full
          // height of the pane beneath it behind a fade (the messages dim as
          // they pass under); only its controls take pointer events, so the
          // faded strip below them still scrolls the transcript. Mobile adds
          // the safe-area inset and glass controls.
          'pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_[role=button]]:pointer-events-auto',
          'bg-gradient-to-b from-background via-background/75 to-transparent px-3 pb-6 pt-[calc(env(safe-area-inset-top)+0.75rem)]',
        )}
        layout
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onBack ? (
            <MobileChatTitle onBack={onBack} />
          ) : (
            /* The bots themselves are the header: one permanent thread per bot
               (RFC 02), so picking a bot is how you move between chats. */
            <BotStrip compact={!isExpanded} className="flex-1" />
          )}
          {/* While an insight is open: the outline each turn carries (MB-550). */}
          <InsightContextButton />
        </div>
        <div className="flex items-center gap-1">
          <Select value={effortChoice} onValueChange={(v) => setEffortChoice(v as typeof effortChoice)}>
            <SelectTrigger
              className={cn(
                'h-7 w-auto min-w-[72px] max-w-[100px] text-xs border-0 bg-transparent shadow-none focus:ring-0 px-2 gap-1',
                onBack && 'liquid-glass liquid-glass-control pointer-events-auto h-11 rounded-full px-4 text-[13px] font-medium',
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  <span className="font-medium">{opt.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!hideExpandToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <motion.div
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onToggleExpand}
                    className="h-7 w-7 p-0"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={isExpanded ? 'minimize' : 'maximize'}
                        initial={{ rotate: -90, opacity: 0 }}
                        animate={{ rotate: 0, opacity: 1 }}
                        exit={{ rotate: 90, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        {isExpanded ? (
                          <Minimize2 className="h-4 w-4" />
                        ) : (
                          <Maximize2 className="h-4 w-4" />
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </Button>
                </motion.div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{isExpanded ? 'Collapse' : 'Expand'}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </motion.div>
      <ChatContent isExpanded={isExpanded} floating topInset={headerHeight} />
    </motion.div>
  );
}
