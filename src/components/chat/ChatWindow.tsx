"use client";

import type { UIMessage } from "@ai-sdk/react";
import { useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowDown, LoaderCircle, MessageSquarePlus, Send, Lightbulb } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChatTextarea } from "./ChatTextarea";
import { ChatMessageBubble, LoadingBubble } from "./ChatMessageBubble";
import { useChatContext } from "./ChatProvider";
import { AttachButton, AttachmentChips, useAttachmentDrop } from "./ChatComposerAttachments";
import { CachedChatPreview } from "./CachedChatPreview";
import { ChatSuggestions } from "./ChatSuggestions";
import { ModelPill } from "./ModelSelector";
import { useCopilotAgent } from "./CopilotAgentContext";

const MNA_WELCOME_MESSAGE = `# Hello! I'm your M&A discovery assistant. I can help you with

---

🔍 **Company Discovery** - Find acquisition targets by sector
🔬 **Deep Dive Analysis** - Detailed company assessments
⚖️ **Comparison & Synergy** - Compare companies, evaluate fit
📊 **Pipeline Insights** - Performance metrics and bottlenecks

---

💡 **Try asking:**
• "Find semiconductor companies"
• "Show me the top 3 petrochemical companies in Korea between 100 million and 1 billion enterprise value"
• "Show me the notes where Project Sunrise is mentioned"
• "Pipeline performance summary"
• "Which companies are in the L0 step and how long have they been there?"`;

const INVESTMENT_WELCOME_MESSAGE = `# Hello! I'm your Investment Assistant. I can help you with

---

💼 **Fund Asset Deep Dive** - Detailed fund and asset analysis
📊 **Asset Statistics** - Performance and allocation metrics
👥 **Investor Analysis** - LP profiles and investor insights
🌍 **Market Context** - Macroeconomic comparisons and benchmarks

---

💡 **Try asking:**
• "Analyze the performance of all fund assets"
• "Show me the top assets by value"
• "Give me an investor breakdown for this fund"
• "Compare this fund's returns to market benchmarks"
• "What is the current liquidity position across our holdings?"`;

function WelcomeMessage() {
  const agentType = useCopilotAgent();
  const message: UIMessage = {
    id: "welcome",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: agentType === "investment" ? INVESTMENT_WELCOME_MESSAGE : MNA_WELCOME_MESSAGE,
      },
    ],
  };
  return <ChatMessageBubble message={message} />;
}

function ChatMessages(props: {
  messages: UIMessage[];
  emptyStateComponent: ReactNode;
  aiEmoji?: string;
  className?: string;
  isLoading?: boolean;
  isStreaming?: boolean;
  onClearHistory?: () => void;
}) {
  return (
    <div className="w-full min-w-0">
      {props.messages.length > 0 && props.onClearHistory && (
        <div className="sticky top-2 z-20 flex justify-end pb-2 pr-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onClearHistory}
            className="ml-auto text-muted-foreground hover:text-foreground gap-1.5 bg-background/90 backdrop-blur supports-[backdrop-filter]:backdrop-blur"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New Chat
          </Button>
        </div>
      )}
      <div className="flex flex-col min-w-0 max-w-[768px] mx-auto pb-12 w-full">
        <WelcomeMessage />
        {props.messages.map((message, index) => (
          <ChatMessageBubble
            key={message.id}
            message={message}
            aiEmoji={props.aiEmoji}
            isActive={!!props.isStreaming && index === props.messages.length - 1}
          />
        ))}
        {props.isLoading && <LoadingBubble />}
      </div>
    </div>
  );
}

const SUGGESTION_CHIPS = [
  "semiconductor companies",
  "analyze Project Oriole and why is it a good fit",
  "observe the pipeline performance and how long companies are in L1",
];

const CHAT_INPUT_PLACEHOLDER =
  "Ask about companies, analysis, comparisons, or pipeline performance...";

export function ChatInput(props: {
  onSubmit: () => void;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  loading?: boolean;
  placeholder?: string;
  suggestionChips?: string[];
  onChipClick?: (chip: string) => void;
  className?: string;
  inputRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const chips = props.suggestionChips ?? SUGGESTION_CHIPS;
  const { attachments, modelChoice, setModelChoice } = useChatContext();
  const { isDragging, dropHandlers } = useAttachmentDrop();
  const hasReadyAttachment = attachments.some((a) => a.status === "ready");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
      className={cn("w-full space-y-3", props.className)}
      {...dropHandlers}
    >
      <AttachmentChips />
      <div
        className={cn(
          "relative flex items-end gap-2 p-2 bg-background rounded-2xl border",
          isDragging && "ring-2 ring-purple-500 ring-offset-2",
        )}
      >
        <AttachButton disabled={props.loading} className="self-end" />
        <ChatTextarea
          ref={props.inputRef}
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          placeholder={props.placeholder ?? CHAT_INPUT_PLACEHOLDER}
          className="flex-1 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
          disabled={props.loading}
        />
        <ModelPill value={modelChoice} onChange={setModelChoice} />
        <Button
          type="submit"
          disabled={(!props.value.trim() && !hasReadyAttachment) || props.loading}
          className="bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-700 hover:to-purple-600 shrink-0"
        >
          {props.loading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-purple-500/10 text-sm font-medium text-purple-700">
            Drop files to attach
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Lightbulb className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        <span>Try:</span>
        {chips.map((chip, i) => (
          <button
            key={i}
            type="button"
            onClick={() => props.onChipClick?.(chip)}
            className="text-left text-primary hover:underline"
          >
            &quot;{chip}&quot;{i < chips.length - 1 ? "," : ""}
          </button>
        ))}
      </div>
    </form>
  );
}

function ScrollToBottom(props: { className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("rounded-full h-8 w-8 p-0 opacity-80 hover:opacity-100", props.className)}
      onClick={() => scrollToBottom()}
    >
      <ArrowDown className="w-4 h-4" />
      <span className="sr-only">Scroll to bottom</span>
    </Button>
  );
}

function StickyToBottomContent(props: {
  content: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const context = useStickToBottomContext();

  return (
    <div
      ref={context.scrollRef}
      style={{ width: "100%", height: "100%" }}
      className={cn("grid grid-rows-[1fr,auto] overflow-y-auto", props.className)}
    >
      <div ref={context.contentRef} className={props.contentClassName}>
        {props.content}
      </div>

      {props.footer}
    </div>
  );
}

/**
 * Forces a scroll to the bottom when a chat finishes loading from history.
 * Without this, StickToBottom thinks the user "isn't at the bottom" (because
 * the prior render was empty / loading spinner) and skips its auto-scroll
 * when the message list suddenly materializes, leaving the viewport stranded
 * mid-conversation.
 */
function ScrollToBottomAfterLoad() {
  const { isLoadingMessages, messages } = useChatContext();
  const { scrollToBottom } = useStickToBottomContext();
  const wasLoading = useRef(isLoadingMessages);

  useEffect(() => {
    if (wasLoading.current && !isLoadingMessages && messages.length > 0) {
      // Defer to the next frame so the freshly-rendered messages have laid
      // out and the scroll container knows its real scrollHeight.
      requestAnimationFrame(() => {
        void scrollToBottom("instant");
      });
    }
    wasLoading.current = isLoadingMessages;
  }, [isLoadingMessages, messages.length, scrollToBottom]);

  return null;
}

export function ChatLayout(props: {
  content: ReactNode;
  footer: ReactNode;
  contentClassName?: string;
  footerClassName?: string;
}) {
  const footerContent = (
    <>
      <ScrollToBottom className="absolute -top-10 left-1/2 -translate-x-1/2 mb-4" />
      {props.footer}
    </>
  );
  return (
    <StickToBottom>
      <ScrollToBottomAfterLoad />
      <StickyToBottomContent
        className="absolute inset-0"
        contentClassName={cn("py-8 px-4 sm:px-6", props.contentClassName)}
        content={props.content}
        footer={
          props.footerClassName ? (
            <div className={cn("sticky bottom-0 flex-shrink-0", props.footerClassName)}>
              {footerContent}
            </div>
          ) : (
            <div className="sticky bottom-0 px-2 pb-4 pt-4 bg-gradient-to-t from-background via-background to-transparent">
              {footerContent}
            </div>
          )
        }
      />
    </StickToBottom>
  );
}

/**
 * Owns its own input state and pulls `sendMessage`/`status` from context so
 * that typing only re-renders this component, not the entire message tree.
 * (With memoized message bubbles, typing should be near-free.)
 */
function ChatInputContainer({ placeholder }: { placeholder?: string }) {
  const [input, setInput] = useState("");
  const { sendWithCacheCheck, status, chatInputRef, attachments } = useChatContext();
  const isBusy = status === "streaming" || status === "submitted";

  return (
    <div className="max-w-5xl mx-auto space-y-3">
      <ChatInput
        inputRef={chatInputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onSubmit={() => {
          const hasReadyAttachment = attachments.some((a) => a.status === "ready");
          if (!input.trim() && !hasReadyAttachment) return;
          // Attachment-only send still needs a real user turn — fall back to a
          // default prompt so the model has an instruction to act on.
          sendWithCacheCheck(input.trim() ? input : "Please review the attached file(s).");
          setInput("");
        }}
        loading={isBusy}
        placeholder={placeholder ?? CHAT_INPUT_PLACEHOLDER}
        suggestionChips={SUGGESTION_CHIPS}
        onChipClick={(chip) => setInput(chip)}
      />
    </div>
  );
}

export function ChatWindow(props: {
  endpoint: string;
  emptyStateComponent: ReactNode;
  placeholder?: string;
  emoji?: string;
  contentClassName?: string;
  footerClassName?: string;
}) {
  const [isHydrated, setIsHydrated] = useState(false);
  const { messages, status, newChat, isLoadingMessages, cacheHit } =
    useChatContext();

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const handleNewChat = useCallback(() => {
    newChat();
    toast.success("Started a new chat");
  }, [newChat]);

  if (!isHydrated) {
    return null;
  }

  return (
    <ChatLayout
      contentClassName={props.contentClassName}
      footerClassName={props.footerClassName ?? "border-t bg-card p-4 flex-shrink-0"}
      content={
        isLoadingMessages ? (
          <div className="flex items-center justify-center h-full min-h-[300px] text-muted-foreground gap-2">
            <LoaderCircle className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading chat…</span>
          </div>
        ) : cacheHit ? (
          <div className="flex flex-col min-w-0 max-w-[768px] mx-auto pb-12 w-full">
            <WelcomeMessage />
            <CachedChatPreview />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col min-w-0 max-w-[768px] mx-auto pb-12 w-full">
            <WelcomeMessage />
            <ChatSuggestions className="mt-4 px-2" />
          </div>
        ) : (
          <ChatMessages
            aiEmoji={props.emoji}
            messages={messages}
            emptyStateComponent={props.emptyStateComponent}
            isLoading={status === "submitted"}
            isStreaming={status === "streaming"}
            onClearHistory={handleNewChat}
          />
        )
      }
      footer={<ChatInputContainer placeholder={props.placeholder} />}
    />
  );
}
