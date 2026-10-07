'use client';

import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import posthog from 'posthog-js';
import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CHAT_LINK_CLICKED,
  chatLinkProperties,
  linkTextOf,
  type ChatSurface,
} from '@/lib/posthog-chat';
import { evidenceLabelOf, isDataLimitBlock } from '@/lib/chat/evidenceLabels';
import type { ChatEvidenceLabel } from '@/lib/agents/sector/evidenceMarkers';
import type { Components } from 'react-markdown';

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
  /**
   * Style the sector agents' evidence forms (MB-542, MB-543): a paragraph
   * opening **Data limit:** as a guardrail callout, and a bold Observed /
   * Inferred / Modelled as a pill. Opt-in, so only the assistant's answer is
   * affected — never a user message, a tool trace or any other markdown.
   */
  evidenceMarkers?: boolean;
}

const DATA_LIMIT_CALLOUT =
  'my-2 flex items-start gap-2 rounded-lg border border-amber-500 bg-muted px-3 py-2 text-foreground dark:border-amber-400';

// Opaque fills in both themes: a pill must never let the bubble show through.
const EVIDENCE_PILL: Record<ChatEvidenceLabel, string> = {
  observed:
    'border-emerald-600 bg-emerald-100 text-emerald-900 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-100',
  inferred:
    'border-violet-600 bg-violet-100 text-violet-900 dark:border-violet-400 dark:bg-violet-950 dark:text-violet-100',
  modelled:
    'border-blue-600 bg-blue-100 text-blue-900 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100',
};

/**
 * Hoisted so the plugin array isn't a fresh literal on every render —
 * react-markdown treats a new `remarkPlugins` identity as a reason to rebuild
 * its processor.
 */
const REMARK_PLUGINS = [remarkGfm];

function buildComponents(
  isCard: boolean,
  linkSurface: ChatSurface | undefined,
  evidenceMarkers: boolean,
): Components {
  return {
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
          p: ({ node, children }) =>
            evidenceMarkers && isDataLimitBlock(node) ? (
              <div data-testid="chat-data-limit" role="note" className={DATA_LIMIT_CALLOUT}>
                <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <p className="m-0 leading-relaxed text-foreground">{children}</p>
              </div>
            ) : (
              <p className={cn("mb-2 last:mb-0 leading-relaxed", isCard ? "text-foreground" : "text-foreground/90")}>{children}</p>
            ),

          // Strong/Bold
          strong: ({ node, children }) => {
            const label = evidenceMarkers ? evidenceLabelOf(node) : null;
            if (label) {
              return (
                <strong
                  data-testid={`chat-evidence-${label}`}
                  className={cn(
                    "inline-block rounded-full border px-2 py-px align-baseline text-[0.75em] font-semibold leading-normal whitespace-nowrap",
                    EVIDENCE_PILL[label],
                  )}
                >
                  {children}
                </strong>
              );
            }
            return (
              <strong className={cn(isCard ? "font-bold text-foreground" : "font-semibold text-foreground")}>{children}</strong>
            );
          },

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
          // A guardrail in a tight bullet list has no <p>, so the <li> itself
          // becomes the callout.
          li: ({ node, children }) =>
            evidenceMarkers && isDataLimitBlock(node) ? (
              <li data-testid="chat-data-limit" role="note" className={cn(DATA_LIMIT_CALLOUT, "list-none -ml-5")}>
                <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <span className="min-w-0 leading-relaxed text-foreground">{children}</span>
              </li>
            ) : (
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
  };
}

function MarkdownRendererImpl({
  content,
  className,
  variant = 'chat',
  linkSurface,
  evidenceMarkers = false,
}: MarkdownRendererProps) {
  const isCard = variant === 'card';

  // The component map closes over all three of these and nothing else, so it
  // is rebuilt only when one of them changes rather than on every render. It
  // used to be an inline literal, which made react-markdown re-parse the
  // whole document each time the bubble re-rendered.
  const components = useMemo(
    () => buildComponents(isCard, linkSurface, evidenceMarkers),
    [isCard, linkSurface, evidenceMarkers],
  );

  return (
    <div className={cn("prose max-w-none break-words dark:prose-invert", isCard ? "prose-base" : "prose-sm", className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Memoized: a chat transcript renders one of these per message (plus one per
 * warning and one for the thinking trace), and markdown parsing is the most
 * expensive thing on the copilot's render path. Every prop is a primitive, so
 * the default shallow compare is exactly right.
 */
export const MarkdownRenderer = memo(MarkdownRendererImpl);
