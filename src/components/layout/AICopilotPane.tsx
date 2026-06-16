'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Maximize2, Minimize2, Send, LoaderCircle, PenLine } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useChatContext } from '@/components/chat/ChatProvider';
import { ChatMessageBubble, LoadingBubble } from '@/components/chat/ChatMessageBubble';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { motion, AnimatePresence } from 'framer-motion';
import type { UIMessage } from '@ai-sdk/react';

const WELCOME_MESSAGE = `# Hello! I'm your M&A discovery assistant.

🔍 **Company Discovery** - Find acquisition targets
🔬 **Deep Dive Analysis** - Detailed assessments
📊 **Pipeline Insights** - Performance metrics`;

const welcomeUIMessage: UIMessage = {
  id: 'welcome-pane',
  role: 'assistant',
  parts: [{ type: 'text', text: WELCOME_MESSAGE }],
};

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

function ChatInput({ isExpanded }: { isExpanded: boolean }) {
  const [input, setInput] = useState('');
  const { sendMessage, status } = useChatContext();
  const isBusy = status === 'streaming' || status === 'submitted';

  const handleSubmit = () => {
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div className="p-4 border-t bg-muted shrink-0">
      <motion.div
        className="mx-auto"
        animate={{ maxWidth: isExpanded ? '48rem' : '100%' }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="flex gap-2 p-2 bg-background rounded-2xl border">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything..."
              className="flex-1 text-sm border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
              disabled={isBusy}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!input.trim() || isBusy}
              className="bg-purple-600 hover:bg-purple-700 shrink-0 rounded-xl"
            >
              {isBusy ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function ChatContent({ isExpanded }: { isExpanded: boolean }) {
  const { messages, status } = useChatContext();

  return (
    <StickToBottom className="flex-1 flex flex-col min-h-0">
      <ScrollContent>
        <motion.div
          className="flex flex-col gap-2"
          animate={{
            maxWidth: isExpanded ? '48rem' : '100%',
            marginLeft: isExpanded ? 'auto' : 0,
            marginRight: isExpanded ? 'auto' : 0,
          }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
        >
          <ChatMessageBubble message={welcomeUIMessage} />
          {messages.map((message) => (
            <ChatMessageBubble key={message.id} message={message} />
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
}

export function AICopilotPane({
  isExpanded,
  onToggleExpand,
  width = COPILOT_DEFAULT_WIDTH,
  onResize,
  className,
}: AICopilotPaneProps) {
  const { newChat } = useChatContext();
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

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
      className={cn(
        'relative flex flex-col bg-background border-l h-full sticky top-0 overflow-hidden',
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
    >
      {!isExpanded && onResize && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleResizeStart}
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize',
            'transition-colors hover:bg-purple-500/40',
            isDragging && 'bg-purple-500/60',
          )}
        />
      )}
      <motion.div
        className="flex items-center justify-between p-3 border-b bg-background/80 backdrop-blur-xl shrink-0 sticky top-0 z-10"
        layout
      >
        <div className="flex items-center gap-2">
          <motion.div
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/10"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Sparkles className="h-4 w-4 text-purple-500" />
          </motion.div>
          <span className="text-sm font-medium">AI CoPilot</span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.div
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={newChat}
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
        </div>
      </motion.div>
      <ChatContent isExpanded={isExpanded} />
    </motion.div>
  );
}
