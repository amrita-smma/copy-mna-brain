/**
 * The logic behind the CoPilot insight edit card (MB-554), kept out of the
 * component so it can be tested without a DOM: when the base moved, what the
 * card says about it, and what approving and rejecting do.
 *
 * Browser-safe: no server-only imports.
 */

import { formatInsightDate } from '@/lib/insights/format';
import type { InsightDetail, InsightHead } from '@/lib/insights/types';
import type { PublishInsightVersionParams } from '@/lib/api/insights';

/**
 * How often an open, visible, unresolved card checks the insight's head
 * while the live stream is down; while it is up, the `insights` topic says
 * when a version landed.
 */
export const BASE_POLL_INTERVAL_MS = 30_000;

/** What the card shows once rejected. Rejecting writes nothing anywhere. */
export const REJECT_RESOLUTION_TEXT = 'Rejected — changes dismissed.';

/**
 * True when the insight's current version is no longer the one the card
 * diffed against. Unknown on either side reads as "not moved": the card only
 * claims a move it has seen.
 */
export function hasBaseMoved(
  diffedVersionNo: number | null | undefined,
  head: Pick<InsightHead, 'version_no'> | null | undefined,
): boolean {
  return (
    typeof diffedVersionNo === 'number' &&
    typeof head?.version_no === 'number' &&
    head.version_no !== diffedVersionNo
  );
}

/** The base moved: from the version first diffed to the one now current. */
export interface BaseMove {
  fromVersionNo: number;
  toVersionNo: number;
  publishedAt: string;
  trigger: string;
}

/** Who published a version, as a phrase: "a scheduled refresh". */
export function versionTriggerPhrase(trigger: string): string {
  switch (trigger) {
    case 'routine':
      return 'a scheduled refresh';
    case 'workforce':
      return 'an AI Workforce run';
    case 'copilot_edit':
      return 'another approved CoPilot edit';
    case 'rollback':
      return 'a rollback';
    case 'copilot_create':
    case 'upload':
    case 'duplicate':
      return 'a new version';
    default:
      return 'another change';
  }
}

/**
 * "This insight moved to v7 (published by a scheduled refresh at 24 Sept 2026,
 * 10:00) since this edit was proposed — the changes below are against v7."
 */
export function baseMovedMessage(
  move: BaseMove,
  formatDate: (value: string) => string = formatInsightDate,
): string {
  const when = formatPublishedAt(move.publishedAt, formatDate);
  return `This insight moved to v${move.toVersionNo} (published by ${versionTriggerPhrase(move.trigger)}${when ? ` at ${when}` : ''}) since this edit was proposed — the changes below are against v${move.toVersionNo}. Approving publishes this edit over v${move.toVersionNo}.`;
}

function formatPublishedAt(value: string, formatDate: (value: string) => string): string {
  if (!value) return '';
  // Postgres text timestamps ("2026-09-24 03:12:45.123+00") are not ISO;
  // make them so before parsing.
  const iso = value.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})?$/,
    (_m, date: string, time: string, zone?: string) => `${date}T${time}${zone ? `${zone}:00` : ''}`,
  );
  if (Number.isNaN(new Date(iso).getTime())) return '';
  return formatDate(iso);
}

/** The next base once the head moved: the refetched version, diffed. */
export function nextBaseMove(
  firstDiffedVersionNo: number,
  current: Pick<InsightDetail, 'version_no'>,
  head: InsightHead | null,
): BaseMove | null {
  if (current.version_no === firstDiffedVersionNo) return null;
  return {
    fromVersionNo: firstDiffedVersionNo,
    toVersionNo: current.version_no,
    publishedAt: head?.version_no === current.version_no ? head.created_at : '',
    trigger: head?.version_no === current.version_no ? head.trigger : '',
  };
}

export interface InsightEditActionDeps {
  publishInsightVersion: (id: string, params: PublishInsightVersionParams) => Promise<InsightDetail>;
}

export interface ApproveInsightEditInput {
  insightId: string;
  /** The candidate exactly as proposed — never the highlighted preview. */
  html: string;
  summary: string;
  /** The version the card diffed against (the one on screen). */
  baseVersionNo: number | null;
  chatId: string | null;
}

/**
 * What the card's two buttons do. Approve publishes the untouched candidate
 * over the version the user reviewed (a moved base answers 409). Reject writes
 * nothing — no version, no draft row, no request: the only trace is the
 * card's own resolved state in the browser.
 */
export function createInsightEditActions(deps: InsightEditActionDeps) {
  return {
    approve(input: ApproveInsightEditInput): Promise<InsightDetail> {
      return deps.publishInsightVersion(input.insightId, {
        html: input.html,
        label: input.summary,
        baseVersionNo: input.baseVersionNo,
        chat_id: input.chatId,
      });
    },
    reject(): string {
      return REJECT_RESOLUTION_TEXT;
    },
  };
}
