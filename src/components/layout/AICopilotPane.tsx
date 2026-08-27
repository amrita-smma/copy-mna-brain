'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Maximize2, Minimize2, Send, Square, PenLine, History } from 'lucide-react';
import posthog from 'posthog-js';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useChatContext } from '@/components/chat/ChatProvider';
import { ChatTextarea } from '@/components/chat/ChatTextarea';
import {
  AttachButton,
  AttachmentChips,
  useAttachmentDrop,
  useAttachmentPaste,
} from '@/components/chat/ChatComposerAttachments';
import { ChatSidebar } from '@/components/chat/ChatSidebar';
import { ChatMessageBubble, LoadingBubble } from '@/components/chat/ChatMessageBubble';
import { CachedChatPreview } from '@/components/chat/CachedChatPreview';
import { ChatSuggestions } from '@/components/chat/ChatSuggestions';
import { OPTIONS } from '@/components/chat/EffortSelector';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/useAuth';
import { useLayoutControl } from './LayoutControlContext';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * The greeting's first name. `user.name` is a full display name, so take the
 * leading word; a blank/absent name falls back to a neutral address rather than
 * an awkward "Ask away, !".
 */
function firstNameOf(name: string | undefined): string {
  return name?.trim().split(/\s+/)[0] || 'there';
}

function ScrollContent({ children }: { children: React.ReactNode }) {
  const context = useStickToBottomContext();

  return (
    <div
      ref={context.scrollRef}
      className="flex-1 overflow-y-auto min-h-0"
    >
      <div ref={context.contentRef} className="p-4">
        {children}
      </div>
    </div>
  );
}

// How long the user must be idle (no typing) before the "… Enhance"
// affordance appears next to the composer.
const ENHANCE_IDLE_MS = 1250;

/**
 * Where the composer is sitting. `docked` is the classic bottom-of-transcript
 * bar; `hero` is the free-standing box under the greeting on an empty chat,
 * which carries no border or fill of its own.
 */
type ComposerPlacement = 'docked' | 'hero';

function ChatInput({
  isExpanded,
  placement = 'docked',
}: {
  isExpanded: boolean;
  placement?: ComposerPlacement;
}) {
  const [input, setInput] = useState('');
  const [showEnhance, setShowEnhance] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when an enhancement succeeds so we can re-focus the textarea only
  // after it re-enables (focusing while still disabled is a no-op).
  const refocusAfterEnhanceRef = useRef(false);
  const { sendWithCacheCheck, status, stop, chatInputRef, attachments } = useChatContext();
  const { onPaste } = useAttachmentPaste();
  const isBusy = status === 'streaming' || status === 'submitted';
  const hasReadyAttachment = attachments.some((a) => a.status === 'ready');

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

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

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setInput(next);
    scheduleIdleCheck(next);
  };

  const handleSubmit = () => {
    if (isBusy) return;
    if (!input.trim() && !hasReadyAttachment) return;
    // Attachment-only send still needs a real user turn — fall back to a
    // default prompt so the model has an instruction to act on.
    sendWithCacheCheck(input.trim() ? input : 'Please review the attached file(s).');
    setInput('');
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

  const isHero = placement === 'hero';

  return (
    <div className={cn('shrink-0', isHero ? 'w-full' : 'p-4 border-t bg-muted')}>
      <motion.div
        className="mx-auto"
        animate={{ maxWidth: isExpanded && !isHero ? '95%' : '100%' }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          onPaste={onPaste}
        >
          <AttachmentChips className="mb-2" />
          <div
            className={cn(
              'relative flex items-end gap-2 rounded-2xl border bg-background p-2',
              // The hero composer is the focal point of an empty chat, so it
              // gets a little more presence than the docked bar.
              isHero && 'rounded-3xl p-2.5 shadow-lg shadow-black/5 dark:shadow-black/20',
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
                onKeyDown={(e) => {
                  // Shift+Tab enhances the draft instead of moving focus.
                  if (e.key === 'Tab' && e.shiftKey && input.trim() && !isEnhancing && !isBusy) {
                    e.preventDefault();
                    handleEnhance('shortcut');
                  }
                }}
                placeholder="Ask anything..."
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
                className="bg-red-600 hover:bg-red-700 shrink-0 rounded-xl"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!input.trim() && !hasReadyAttachment}
                className="bg-blue-600 hover:bg-blue-700 shrink-0 rounded-xl"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>
      </motion.div>
    </div>
  );
}

/**
 * An untouched chat: a greeting, the composer, and a few starting points —
 * centered, with nothing else on screen. Replaces the old canned "Hello! I'm
 * your M&A assistant" message bubble, which spent the user's first impression
 * listing features instead of inviting a question.
 */
function ChatEmptyState({ isExpanded }: { isExpanded: boolean }) {
  const { user } = useAuth();

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto p-4 min-h-0">
      <div className={cn('w-full', isExpanded ? 'max-w-2xl' : 'max-w-full')}>
        <h1
          className={cn(
            'bg-gradient-to-r from-blue-600 via-indigo-500 to-blue-500 bg-clip-text pb-1 font-medium tracking-tight text-transparent dark:from-blue-400 dark:via-indigo-300 dark:to-blue-300',
            isExpanded ? 'text-3xl sm:text-4xl' : 'text-2xl',
          )}
        >
          Ask away, {firstNameOf(user?.name)}!
        </h1>
        <div className="mt-6">
          <ChatInput isExpanded={isExpanded} placement="hero" />
        </div>
        <ChatSuggestions
          className={cn('mt-4', isExpanded ? 'sm:grid-cols-2' : 'grid-cols-1')}
        />
      </div>
    </div>
  );
}

function ChatContent({ isExpanded }: { isExpanded: boolean }) {
  const { messages, status, cacheHit } = useChatContext();
  const isStreaming = status === 'streaming';

  // A pending cached-chat preview is content in its own right, so it belongs in
  // the transcript view even before any message exists.
  if (messages.length === 0 && !cacheHit) {
    return <ChatEmptyState isExpanded={isExpanded} />;
  }

  return (
    <StickToBottom className="flex-1 flex flex-col min-h-0">
      <ScrollContent>
        <motion.div
          className="flex flex-col gap-2"
          animate={{
            maxWidth: isExpanded ? '95%' : '100%',
            marginLeft: isExpanded ? 'auto' : 0,
            marginRight: isExpanded ? 'auto' : 0,
          }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
        >
          <CachedChatPreview />
          {messages.map((message, index) => (
            <ChatMessageBubble
              key={message.id}
              message={message}
              isActive={isStreaming && index === messages.length - 1}
            />
          ))}
          {status === 'submitted' && <LoadingBubble />}
        </motion.div>
      </ScrollContent>
      <ChatInput isExpanded={isExpanded} />
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
   * Show a chat-history button that opens the chat list in a slide-in drawer.
   * Used by the mobile layout, which has no room for a persistent sidebar.
   */
  showHistoryButton?: boolean;
}

export function AICopilotPane({
  isExpanded,
  onToggleExpand,
  width = COPILOT_DEFAULT_WIDTH,
  onResize,
  className,
  hideExpandToggle = false,
  showHistoryButton = false,
}: AICopilotPaneProps) {
  const { newChat, focusComposer, effortChoice, setEffortChoice } = useChatContext();
  const { expandCopilot } = useLayoutControl();
  const [historyOpen, setHistoryOpen] = useState(false);
  // Set when the history drawer is closing because the user picked a chat (or
  // started a new one), as opposed to just dismissing it — see the drawer's
  // `onCloseAutoFocus`.
  const drawerChoseChatRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  // File drag-and-drop covers the entire pane, not just the composer — drop a
  // file anywhere on the copilot to attach it.
  const { isDragging: isFileDragging, dropHandlers } = useAttachmentDrop();

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
        className={cn(
          'flex items-center justify-between p-3 shrink-0 sticky top-0 z-10',
          // Full-screen, the copilot IS the page — a titled, ruled header would
          // just be chrome around it. Docked, the rule is what separates the
          // pane from the console beside it.
          isExpanded
            ? 'bg-transparent'
            : 'border-b bg-background/80 backdrop-blur-xl',
        )}
        layout
      >
        <div className="flex items-center gap-2">
          {showHistoryButton && (
            <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label="Chats and pages"
                >
                  <History className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="flex w-72 flex-col p-0"
                // Choosing a chat closes this drawer, and Radix would then
                // restore focus to the history button — undoing the composer
                // focus the choice just asked for. Keep the caret in the
                // composer in that case. A plain dismiss (Esc, overlay tap)
                // still gets the default restore, so closing the drawer never
                // pops the keyboard on its own.
                onCloseAutoFocus={(e) => {
                  if (!drawerChoseChatRef.current) return;
                  drawerChoseChatRef.current = false;
                  e.preventDefault();
                  focusComposer();
                }}
              >
                <SheetHeader className="p-4 pb-0">
                  <SheetTitle>Chats &amp; pages</SheetTitle>
                </SheetHeader>
                <ChatSidebar
                  className="w-full flex-1 border-r-0"
                  onNavigate={(target) => {
                    // Only a chat keeps the user on this screen, so only a chat
                    // should pull the caret back into the composer. Picking a
                    // page navigates away — focusing the composer there would
                    // pop the keyboard over the page just opened.
                    drawerChoseChatRef.current = target === 'chat';
                    setHistoryOpen(false);
                  }}
                />
              </SheetContent>
            </Sheet>
          )}
          {!isExpanded && (
            <>
              <motion.div
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <Sparkles className="h-4 w-4 text-blue-500" />
              </motion.div>
              <span className="text-sm font-medium">AI CoPilot</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Select value={effortChoice} onValueChange={(v) => setEffortChoice(v as typeof effortChoice)}>
            <SelectTrigger className="h-7 w-auto min-w-[72px] max-w-[100px] text-xs border-0 bg-transparent shadow-none focus:ring-0 px-2 gap-1">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.div
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    newChat();
                    // Docked, a fresh chat is a greeting and a composer squeezed
                    // into a 384px column — go full-screen for it.
                    expandCopilot();
                  }}
                  className="h-7 w-7 p-0"
                >
                  <PenLine className="h-4 w-4" />
                </Button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>New chat</p>
            </TooltipContent>
          </Tooltip>
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
      <ChatContent isExpanded={isExpanded} />
    </motion.div>
  );
}
