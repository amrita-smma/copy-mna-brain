/**
 * The wire format carrying an insight approval payload from a `propose_*` tool
 * to the chat bubble that renders the approval card.
 *
 * The payload travels inside an HTML comment so it never renders as prose. That
 * makes the encoding load-bearing: an insight document is arbitrary,
 * unsanitized HTML and routinely contains `<!-- … -->`, and a raw-JSON payload
 * would end the enclosing comment at the document's FIRST `-->`. The parser
 * would then fail and the remainder of a multi-kilobyte document would be
 * rendered into the transcript as text.
 *
 * Base64 has no `-` and no `>` in its alphabet, so an encoded payload cannot
 * terminate its own comment whatever the document contains. This is also why
 * the encode and decode live together in one module used by both sides, rather
 * than as a regex duplicated across the tool and the component.
 */

import { BOT_CHANGE_APPROVAL_MARKER, BOT_MESSAGE_MARKER } from '@/lib/bots/approval';

export const INSIGHT_CREATE_APPROVAL_MARKER = 'INSIGHT_CREATE_APPROVAL_JSON';
export const INSIGHT_EDIT_APPROVAL_MARKER = 'INSIGHT_EDIT_APPROVAL_JSON';
export const REPORT_PLAN_APPROVAL_MARKER = 'REPORT_PLAN_APPROVAL_JSON';
export const INSIGHT_REFRESH_APPROVAL_MARKER = 'INSIGHT_REFRESH_APPROVAL_JSON';

export const INSIGHT_APPROVAL_MARKERS = [
  INSIGHT_CREATE_APPROVAL_MARKER,
  INSIGHT_EDIT_APPROVAL_MARKER,
  REPORT_PLAN_APPROVAL_MARKER,
  INSIGHT_REFRESH_APPROVAL_MARKER,
] as const;

/** Base64 of the UTF-8 bytes. Works unchanged on the server and in the browser. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The comment a `propose_*` tool appends to its reply. */
export function encodeApprovalMarker(marker: string, payload: unknown): string {
  return `<!-- ${marker}:${toBase64(JSON.stringify(payload))} -->`;
}

// Only base64 characters and whitespace, so the match cannot run past the
// comment — and cannot be ended early by the document inside it.
function markerRegExp(marker: string, flags: string): RegExp {
  return new RegExp(`<!--\\s*${marker}:([A-Za-z0-9+/=\\s]*?)-->`, flags);
}

/**
 * The payload for `marker` in `text`, or `null` when it is absent or corrupt.
 * Never throws: a malformed payload must degrade to plain text, not take the
 * whole transcript down.
 */
export function extractApprovalPayload<T>(text: string, marker: string): T | null {
  const match = text.match(markerRegExp(marker, 's'));
  if (!match) return null;
  try {
    return JSON.parse(fromBase64(match[1].replace(/\s/g, ''))) as T;
  } catch {
    return null;
  }
}

/**
 * The card's payload: the marker's fields plus the document from the tool call's
 * arguments. A marker written before this change still carries `html` itself.
 */
export function resolveApprovalPayload<T extends { html: string }>(
  marker: Omit<T, 'html'> & { html?: unknown },
  toolInput: unknown,
): T | null {
  if (!marker || typeof marker !== 'object') return null;

  if (typeof marker.html === 'string' && marker.html.length > 0) {
    return { ...marker, html: marker.html } as T;
  }

  const inputHtml = (toolInput as { html?: unknown } | null | undefined)?.html;
  if (typeof inputHtml === 'string') {
    return { ...marker, html: inputHtml.trim() } as T;
  }

  return null;
}


/** Every marker written with `encodeApprovalMarker`: the insight cards and the bot cards. */
const ENCODED_MARKERS = [...INSIGHT_APPROVAL_MARKERS, BOT_CHANGE_APPROVAL_MARKER, BOT_MESSAGE_MARKER];

/** Removes every encoded approval comment, so no payload renders as prose. */
export function stripApprovalMarkers(text: string): string {
  let out = text;
  for (const marker of ENCODED_MARKERS) {
    out = out.replace(
      new RegExp(`\\n*<!--\\s*${marker}:[A-Za-z0-9+/=\\s]*?-->`, 'gs'),
      '',
    );
  }
  return out;
}
