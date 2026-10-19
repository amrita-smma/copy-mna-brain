/**
 * Event names and property builders for copilot/chat telemetry.
 *
 * The capture calls themselves live at their call sites (client components for
 * the click events, `src/app/api/chat/route.ts` for the send event), but the
 * event names and the shape of their properties live here so:
 *
 *  - every producer agrees on one spelling — a dashboard insight filtering on
 *    `chat_link_clicked` breaks silently the day a second call site invents
 *    `chat_link_click`;
 *  - the classification logic (what counts as an external link, what counts as
 *    an image attachment) is pure and unit-tested rather than inlined in JSX.
 */

/** A chat turn was submitted by the user. Captured server-side in `POST /api/chat`. */
export const CHAT_MESSAGE_SENT = 'chat_message_sent';
/** A hyperlink inside a rendered chat message was clicked. */
export const CHAT_LINK_CLICKED = 'chat_link_clicked';
/** An in-app navigation affordance rendered by the chat was clicked. */
export const CHAT_NAVIGATION_CLICKED = 'chat_navigation_clicked';
/** A composer attachment finished uploading to S3. */
export const CHAT_ATTACHMENT_UPLOADED = 'chat_attachment_uploaded';

/** Which chat UI the event came from — the docked copilot or the floating widget. */
export type ChatSurface = 'copilot' | 'widget';

/**
 * Which affordance the user pressed.
 *
 * `company_chip` is the inline chip in a message, `bulk_card` the arrow button
 * on a row of the bulk drop/promote approval cards, `workforce_handoff` the
 * "view in Workforce" button on the handoff card, and `workforce_trace` an
 * "Open <company>" chip between the steps of a Workforce task's trace.
 */
export type ChatNavigationSource = 'company_chip' | 'bulk_card' | 'workforce_handoff' | 'workforce_trace';

export type LinkKind = 'internal' | 'external' | 'anchor' | 'mailto' | 'tel' | 'unknown';

/**
 * Bucket a raw `href` into something filterable, and pull out the host for
 * external links so "which sources does the copilot send people to" is a
 * one-property breakdown.
 *
 * Deliberately does not consult `window.location`: an absolute `http(s)` URL is
 * counted as external even when it happens to point at our own origin, because
 * the copilot only ever emits absolute URLs for third-party sources.
 */
export function classifyLink(href: string | null | undefined): {
  link_url: string | null;
  link_host: string | null;
  link_kind: LinkKind;
} {
  const url = typeof href === 'string' ? href.trim() : '';
  if (!url) return { link_url: null, link_host: null, link_kind: 'unknown' };

  if (url.startsWith('#')) return { link_url: url, link_host: null, link_kind: 'anchor' };
  if (url.startsWith('mailto:')) return { link_url: url, link_host: null, link_kind: 'mailto' };
  if (url.startsWith('tel:')) return { link_url: url, link_host: null, link_kind: 'tel' };
  if (url.startsWith('/')) return { link_url: url, link_host: null, link_kind: 'internal' };

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { link_url: url, link_host: parsed.hostname, link_kind: 'external' };
    }
  } catch {
    // Not a parseable absolute URL — fall through to 'unknown'.
  }
  return { link_url: url, link_host: null, link_kind: 'unknown' };
}

/**
 * Flatten a markdown link's children down to its visible text.
 *
 * react-markdown hands `<a>` an array of nodes, not a string — a link whose
 * label contains any emphasis or code span arrives as `['see ', {…}, ' here']`.
 * Reading `children` directly would record `null` for exactly the links worth
 * naming, so walk the tree and keep the string leaves.
 */
export function linkTextOf(children: unknown): string | null {
  if (typeof children === 'string') return children || null;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    const parts = children.map(linkTextOf).filter((p): p is string => p !== null);
    return parts.length ? parts.join('') : null;
  }
  const nested = (children as { props?: { children?: unknown } })?.props?.children;
  return nested === undefined ? null : linkTextOf(nested);
}

/** Properties for {@link CHAT_LINK_CLICKED}. */
export function chatLinkProperties(args: {
  href: string | null | undefined;
  surface: ChatSurface;
  /** Visible anchor text, truncated — useful for spotting citation links. */
  linkText?: string | null;
}): Record<string, unknown> {
  return {
    ...classifyLink(args.href),
    surface: args.surface,
    link_text: truncate(args.linkText ?? null, 120),
  };
}

/** Properties for {@link CHAT_NAVIGATION_CLICKED}. */
export function chatNavigationProperties(args: {
  source: ChatNavigationSource;
  /** Workspace-relative destination, e.g. `/pipeline?company=…`. */
  path: string;
  companyId?: string | null;
  label?: string | null;
}): Record<string, unknown> {
  return {
    source: args.source,
    destination_path: args.path,
    company_id: args.companyId ?? null,
    label: truncate(args.label ?? null, 120),
  };
}

/** `image` / `pdf` / `document`, derived from the MIME type the browser reported. */
export function attachmentKind(contentType: string | null | undefined): 'image' | 'pdf' | 'document' {
  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'document';
}

/** Lowercased extension without the dot, or `null` when the name has none. */
export function fileExtension(fileName: string | null | undefined): string | null {
  const name = (fileName ?? '').trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Properties for {@link CHAT_ATTACHMENT_UPLOADED}. */
export function chatAttachmentProperties(args: {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  surface: ChatSurface;
}): Record<string, unknown> {
  return {
    file_name: args.fileName,
    content_type: args.contentType,
    file_kind: attachmentKind(args.contentType),
    file_extension: fileExtension(args.fileName),
    size_bytes: args.sizeBytes,
    surface: args.surface,
  };
}

/**
 * Properties for {@link CHAT_MESSAGE_SENT}.
 *
 * `is_new_chat` is what separates "started a conversation" from "kept one
 * going" — the retention question the dashboard actually asks.
 */
export function chatMessageSentProperties(args: {
  chatId: string;
  isNewChat: boolean;
  effort: string;
  attachmentCount: number;
  messageLength: number;
  copilotAgent: string;
  hasPageContext: boolean;
  pageContextTab?: string | null;
}): Record<string, unknown> {
  return {
    chat_id: args.chatId,
    is_new_chat: args.isNewChat,
    effort: args.effort,
    attachment_count: args.attachmentCount,
    has_attachments: args.attachmentCount > 0,
    message_length: args.messageLength,
    copilot_agent: args.copilotAgent,
    has_page_context: args.hasPageContext,
    page_context_tab: args.pageContextTab ?? null,
  };
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
