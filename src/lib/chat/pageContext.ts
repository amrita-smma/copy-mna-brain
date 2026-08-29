/**
 * What the user is currently looking at in the center console, as the copilot
 * sees it.
 *
 * The client sends this with every chat turn (see `pageContextStore` and
 * `ChatProvider`'s transport body); the chat route sanitizes it and hands it to
 * the agent via LangGraph `configurable.pageContext`, where the
 * `read_page_context` tool reads it. Shared by both sides so the shape can't
 * drift — no server-only imports here.
 */
import { findTabBySlug } from '@/lib/navigation/consoleTabs';

/** Cap on the view-supplied `detail` string, so a runaway view can't flood the prompt. */
export const MAX_PAGE_DETAIL_LENGTH = 1500;
/** Cap on `path`, which is URL-derived and therefore attacker-influenced. */
export const MAX_PAGE_PATH_LENGTH = 300;

/** Canonical 8-4-4-4-12 UUID, the shape every `companies.id` takes. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PageContext {
  /** Console tab slug, or `null` when the user is in the full-screen chat. */
  tabSlug: string | null;
  /** Workspace-relative path, e.g. `/pipeline/8f2c…`. */
  path: string;
  /**
   * Optional free-text enrichment supplied by the view itself via
   * `useSetPageDetail` — the record on screen, active filters, row counts.
   */
  detail?: string;
  /**
   * The `companies.id` of the deal the user has open, when one is open —
   * supplied by the view via `useSetPageCompanyId`.
   *
   * Carried as its own field rather than buried in `detail` prose so the agent
   * can hand it straight to a company_id-taking tool. That matters most for
   * companies whose names are near-identical (or non-Latin): resolving by name
   * can land on a sibling record, and the id can't.
   */
  companyId?: string;
}

/**
 * Normalizes a `page_context` payload straight off the wire.
 *
 * Everything here arrives from the browser, so nothing is trusted: `tabSlug`
 * must name a real console tab (otherwise it's dropped to `null`), `path` must
 * be a workspace-relative path, and `detail` is length-clamped. Returns `null`
 * when there's nothing usable, which the tool reports as "not on a page".
 */
export function sanitizePageContext(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  const rawPath = typeof input.path === 'string' ? stripControlChars(input.path) : '';
  // A leading slash is the whole contract: it keeps an absolute URL (which
  // would leak an arbitrary host into the prompt) out of the payload. Backticks
  // would close the `Path: \`…\`` fence in formatPageContext.
  const path =
    rawPath.startsWith('/') && !rawPath.startsWith('//')
      ? rawPath.replace(/`/g, '').slice(0, MAX_PAGE_PATH_LENGTH)
      : '';
  if (!path) return null;

  const rawSlug = typeof input.tabSlug === 'string' ? input.tabSlug.trim() : '';
  const tabSlug = findTabBySlug(rawSlug) ? rawSlug : null;

  const rawDetail = typeof input.detail === 'string' ? stripControlChars(input.detail) : '';
  const detail = rawDetail ? rawDetail.slice(0, MAX_PAGE_DETAIL_LENGTH) : undefined;

  // Only a well-formed UUID survives: the value is quoted into the prompt as an
  // id the agent will pass to write tools, so anything else is dropped rather
  // than forwarded.
  const rawCompanyId = typeof input.companyId === 'string' ? input.companyId.trim() : '';
  const companyId = UUID_RE.test(rawCompanyId) ? rawCompanyId : undefined;

  return {
    tabSlug,
    path,
    ...(detail ? { detail } : {}),
    ...(companyId ? { companyId } : {}),
  };
}

/**
 * Collapses control characters (including newlines) to single spaces.
 *
 * `detail` is rendered into the model's view of the page inside a labelled
 * block. Left alone, a value carrying newlines could close that block and write
 * what looks like fresh instructions — the user's own prompt injecting into
 * their own conversation, but a boundary worth keeping tight regardless. Keeping
 * `detail` to one line is what makes the block unambiguous.
 */
function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** Renders a sanitized context as the markdown the `read_page_context` tool returns. */
export function formatPageContext(context: PageContext): string {
  const tab = context.tabSlug ? findTabBySlug(context.tabSlug) : undefined;
  const lines = [
    tab
      ? `The user is on the **${tab.label}** page (${tab.purpose})`
      : `The user is in the full-screen chat, not on a specific page`,
    `Path: \`${context.path}\``,
  ];
  if (context.detail) {
    lines.push('', 'What is on screen:', context.detail);
  }
  if (context.companyId) {
    lines.push(
      '',
      `Open company: \`company_id ${context.companyId}\``,
      'Pass this id VERBATIM to any tool that takes a company_id (get_company_details, update_company_card_section, …).',
      'Do NOT re-resolve this company by name — near-identical names resolve to the wrong record.',
    );
  }
  return lines.join('\n');
}
