'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { UIMessage } from '@ai-sdk/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { Bot, Send, X, Maximize2, Minimize2, Sparkles, GripVertical } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useChatContext } from '@/components/chat/ChatProvider';
import { EffortSelector } from '@/components/chat/EffortSelector';
import { joinTextParts } from '@/lib/chat/textParts';

function getTextFromUIMessage(m: UIMessage): string {
  const parts = (m as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
  return joinTextParts(parts.filter((p) => p.type === 'text').map((p) => p.text ?? ''));
}

function scrubThinkingMarkers(text: string): string {
  const start = '<!-- THINKING_START -->';
  const end = '<!-- THINKING_END -->';

  if (!text.includes(start) && !text.includes(end)) return text;

  // Remove all THINKING_START...THINKING_END blocks (and any unclosed trailing block)
  let result = '';
  let remaining = text;

  while (remaining.length > 0) {
    const startIdx = remaining.indexOf(start);
    if (startIdx === -1) {
      result += remaining;
      break;
    }
    result += remaining.slice(0, startIdx);
    remaining = remaining.slice(startIdx + start.length);

    const endIdx = remaining.indexOf(end);
    if (endIdx !== -1) {
      remaining = remaining.slice(endIdx + end.length);
    } else {
      // Unclosed thinking block — discard the rest (still streaming)
      break;
    }
  }

  result = result
    .replace(/<!--\s*THINKING_(?:START|END)\s*-->/g, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

  return result.trim();
}

const DRAG_THRESHOLD = 5;

function useDraggable(initialPos: { x: number; y: number }) {
  const [position, setPosition] = useState(initialPos);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });
  const hasDragged = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true);
    hasDragged.current = false;
    startPos.current = { x: e.clientX, y: e.clientY };
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    e.preventDefault();
  }, [position]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      if (!hasDragged.current && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        hasDragged.current = true;
      }
      const newX = e.clientX - dragOffset.current.x;
      const newY = e.clientY - dragOffset.current.y;
      const maxX = window.innerWidth - 80;
      const maxY = window.innerHeight - 40;
      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    };

    const handleMouseUp = () => setIsDragging(false);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return { position, setPosition, isDragging, hasDragged, handleMouseDown };
}

export function ChatbotWidget({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, status, effortChoice, setEffortChoice } = useChatContext();

  const fabDrag = useDraggable({ x: 0, y: 0 });
  const widgetDrag = useDraggable({ x: 0, y: 0 });
  const [posInitialized, setPosInitialized] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
    if (!posInitialized) {
      fabDrag.setPosition({ x: window.innerWidth - 80, y: window.innerHeight - 80 });
      widgetDrag.setPosition({ x: window.innerWidth - 410, y: window.innerHeight - 530 });
      setPosInitialized(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, status]);

  const [input, setInput] = useState('');
  const isBusy = status === 'submitted' || status === 'streaming';

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleExpand = () => {
    setIsOpen(false);
    router.push('/ai-discovery');
  };

  return (
    <>
      {/* Floating Action Button */}
      <AnimatePresence>
        {!isOpen && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="fixed z-50"
            style={{ left: fabDrag.position.x, top: fabDrag.position.y }}
          >
            <span className="absolute inset-0 rounded-full bg-accent/30 animate-ping" />
            <span className="absolute -inset-1 rounded-full bg-accent/20 animate-pulse" />
            <Button
              onClick={() => {
                if (!fabDrag.hasDragged.current) {
                  setIsOpen(true);
                  widgetDrag.setPosition({
                    x: Math.min(fabDrag.position.x, window.innerWidth - 410),
                    y: Math.max(0, fabDrag.position.y - 460),
                  });
                }
              }}
              onMouseDown={fabDrag.handleMouseDown}
              className={cn(
                'relative h-14 w-14 rounded-full shadow-xl bg-gradient-to-br from-accent to-blue-700 hover:from-blue-700 hover:to-accent border-2 border-white/20 transition-all duration-300 hover:scale-110 hover:shadow-accent/40 hover:shadow-2xl',
                fabDrag.isDragging && 'cursor-grabbing scale-110'
              )}
              size="icon"
            >
              <Sparkles className="h-6 w-6 text-white drop-shadow-lg" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {isOpen && (
      <Card
        className={cn(
          'fixed z-50 shadow-2xl border-blue-200 dark:border-blue-800/50 overflow-hidden transition-[width,height] duration-200',
          isMinimized ? 'w-80 h-14' : 'w-96 h-[500px]'
        )}
        style={{ left: widgetDrag.position.x, top: widgetDrag.position.y }}
      >
        <div
          className={cn(
            'flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white',
            widgetDrag.isDragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
          onMouseDown={widgetDrag.handleMouseDown}
        >
          <div className="flex items-center gap-2">
            <GripVertical className="h-4 w-4 text-white/50" />
            <Bot className="h-5 w-5" />
            <span className="font-medium select-none">AI CoPilot</span>
          </div>
          <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
              onClick={handleExpand}
              title="Open full AI Discovery"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
              onClick={() => setIsMinimized(!isMinimized)}
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-white/80 hover:text-white hover:bg-white/10"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {!isMinimized && (
          <>
            <ScrollArea className="flex-1 h-[380px] p-4" ref={scrollRef}>
              {!isHydrated ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                  Loading...
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.length === 0 && (
                    <div className="flex gap-3">
                      <div className="flex-shrink-0 h-8 w-8 rounded-lg flex items-center justify-center bg-gradient-to-br from-blue-500 to-blue-600">
                        <Bot className="h-4 w-4 text-white" />
                      </div>
                      <div className="flex-1 rounded-xl px-3 py-2 text-sm bg-muted">
                        <MarkdownRenderer
                          content="Hi! I'm your M&A assistant. Ask about company discovery, deep dives, pipeline insights, or click ↗ to open full AI Discovery."
                          className="text-sm"
                        />
                      </div>
                    </div>
                  )}
                  {messages.map((msg) => {
                    const isUser = msg.role === 'user';
                    let content = getTextFromUIMessage(msg);
                    if (!isUser) content = scrubThinkingMarkers(content);
                    return (
                      <div
                        key={msg.id}
                        className={cn('flex gap-3', isUser && 'flex-row-reverse')}
                      >
                        <div
                          className={cn(
                            'flex-shrink-0 h-8 w-8 rounded-lg flex items-center justify-center',
                            isUser ? 'bg-primary' : 'bg-gradient-to-br from-blue-500 to-blue-600'
                          )}
                        >
                          {isUser ? (
                            <span className="text-xs text-primary-foreground font-medium">You</span>
                          ) : (
                            <Bot className="h-4 w-4 text-white" />
                          )}
                        </div>
                        <div
                          className={cn(
                            'flex-1 rounded-xl px-3 py-2 text-sm',
                            isUser
                              ? 'bg-primary text-primary-foreground ml-auto max-w-[80%]'
                              : 'bg-muted'
                          )}
                        >
                          {isUser ? (
                            <p>{content}</p>
                          ) : (
                            <MarkdownRenderer
                              content={content || '…'}
                              linkSurface="widget"
                              className="text-sm"
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {isBusy && (
                    <div className="flex gap-3">
                      <div className="flex-shrink-0 h-8 w-8 rounded-lg flex items-center justify-center bg-gradient-to-br from-blue-500 to-blue-600">
                        <Bot className="h-4 w-4 text-white" />
                      </div>
                      <div className="bg-muted rounded-xl px-3 py-2">
                        <div className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:-0.3s]" />
                          <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:-0.15s]" />
                          <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>

            <div className="border-t p-3">
              <div className="flex gap-2">
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask me anything..."
                  className="flex-1 text-sm"
                  disabled={isBusy}
                />
                <Button
                  onClick={handleSend}
                  disabled={!input.trim() || isBusy}
                  size="icon"
                  className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex justify-end mt-1.5">
                <EffortSelector value={effortChoice} onChange={setEffortChoice} />
              </div>
            </div>
          </>
        )}
      </Card>
      )}
    </>
  );
}
