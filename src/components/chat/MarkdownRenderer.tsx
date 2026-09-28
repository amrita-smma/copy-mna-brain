'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import posthog from 'posthog-js';
import { cn } from '@/lib/utils';
import {
  CHAT_LINK_CLICKED,
  chatLinkProperties,
  linkTextOf,
  type ChatSurface,
} from '@/lib/posthog-chat';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  variant?: 'chat' | 'card';
  /**
   * Set this when the markdown is a chat message, and links inside it will
   * emit `chat_link_clicked`. Left unset (the default) nothing is captured —
   * the same renderer draws company cards and dashboard blurbs, and a link
   * clicked there is not a chat interaction.
   */
  linkSurface?: ChatSurface;
}

export function MarkdownRenderer({
  content,
  className,
  variant = 'chat',
  linkSurface,
}: MarkdownRendererProps) {
  const isCard = variant === 'card';

  return (
    <div className={cn("prose max-w-none break-words dark:prose-invert", isCard ? "prose-base" : "prose-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Headers
          h1: ({ children }) => (
            <h1 className={cn("font-bold mt-4 mb-2 first:mt-0 text-foreground", isCard ? "text-2xl tracking-tight" : "text-xl")}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className={cn("font-bold mt-4 mb-2 first:mt-0 text-foreground border-b border-border pb-1", isCard ? "text-xl tracking-tight" : "text-lg font-semibold")}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className={cn("font-semibold mt-3 mb-1.5 text-foreground", isCard ? "text-lg" : "text-base")}>{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className={cn("font-semibold mt-2 mb-1 text-foreground", isCard ? "text-base" : "text-sm")}>{children}</h4>
          ),

          // Paragraphs
          p: ({ children }) => (
            <p className={cn("mb-2 last:mb-0 leading-relaxed", isCard ? "text-foreground" : "text-foreground/90")}>{children}</p>
          ),

          // Strong/Bold
          strong: ({ children }) => (
            <strong className={cn(isCard ? "font-bold text-foreground" : "font-semibold text-foreground")}>{children}</strong>
          ),

          // Emphasis/Italic
          em: ({ children }) => (
            <em className={cn("italic", isCard ? "text-foreground/80" : "text-foreground/90")}>{children}</em>
          ),

          // Lists
          ul: ({ children }) => (
            <ul className={cn("my-2 pl-5 list-disc list-outside marker:text-muted-foreground", isCard ? "space-y-1.5" : "space-y-1")}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className={cn("my-2 pl-5 list-decimal list-outside marker:text-muted-foreground", isCard ? "space-y-1.5" : "space-y-1")}>{children}</ol>
          ),
          li: ({ children }) => (
            <li className={cn(isCard ? "text-foreground leading-snug" : "text-foreground/90")}>{children}</li>
          ),

          // Tables - styled to match our UI
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted/50 border-b border-border">{children}</thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-border">{children}</tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-muted/30 transition-colors">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left font-medium text-foreground whitespace-nowrap">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-foreground/90 whitespace-nowrap">{children}</td>
          ),

          // Code blocks
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-xs break-all" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("block max-w-full p-3 rounded-lg bg-muted text-foreground font-mono text-xs overflow-x-auto", className)} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-2 max-w-full rounded-lg bg-muted overflow-x-auto">{children}</pre>
          ),

          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote className="my-2 pl-4 border-l-2 border-primary/50 text-muted-foreground italic">
              {children}
            </blockquote>
          ),

          // Horizontal rules
          hr: () => <hr className="my-4 border-border" />,

          // Links - break long URLs so they don't overflow the bubble
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline break-all"
              onClick={() => {
                if (!linkSurface) return;
                // Fires on the click rather than on navigation: the link opens
                // in a new tab, so there is no unload to race, and a capture
                // here still lands if the user cancels the popup.
                posthog.capture(
                  CHAT_LINK_CLICKED,
                  chatLinkProperties({
                    href,
                    surface: linkSurface,
                    linkText: linkTextOf(children),
                  }),
                );
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
