/**
 * 4-step progressive privacy filter for the ephemeral email processor.
 * Runs before LLM spend; body is only consulted after domain + subject gates
 * where existing shouldSkip already requires it (calendar MIME scan).
 *
 * Step 1 hard-drops only curated excluded domains (not personal providers).
 */

import type { Headers } from './parser';
import { getHeader, parseAddresses } from './parser';
import {
  shouldSkip,
  type FilterOptions,
  type SkipReason,
} from './filter';
import { INTERNAL_MAIL_DOMAINS } from '../lib/mailDomains';

export type PrivacySkipReason =
  | SkipReason
  | 'domain_blacklist'
  | 'sensitive_content'
  | 'sensitive_attachment';

export interface PrivacyFilterResult {
  skip: boolean;
  reason: PrivacySkipReason | '';
  step: 0 | 1 | 2 | 3 | 4;
}

/** HR / sensitive subject markers (step 02). Prefer multi-word phrases so
 * deal mail mentioning "salary expectations" / "comp" is not dropped. */
const SENSITIVE_SUBJECT_PATTERNS = [
  'salary review',
  'compensation review',
  'performance improvement',
  'performance review',
  'benefits enrollment',
  'pay slip',
  'payslip',
  'payroll',
  'employee contract',
  'candidate cv',
  'candidate resume',
  'candidate cover letter',
  'hr confidential',
];

/** Attachment filename markers (step 03) — checked before decode.
 * Aligned with SENSITIVE_SUBJECT_PATTERNS HR/CV classes (filename-safe). */
const SENSITIVE_FILENAME_PATTERNS = [
  /pay[\s_.-]*slip/i,
  /salary[\s_.-]*review/i,
  /compensation[\s_.-]*review/i,
  /payroll/i,
  /employee[\s_.-]*contract/i,
  /hr[\s_.-]*performance/i,
  /performance[\s_.-]*review/i,
  /(?:^|[^a-z0-9])cv(?:[^a-z0-9]|$)/i,
  /(?:^|[^a-z0-9])resume(?:[^a-z0-9]|$)/i,
  /cover[\s_.-]*letter/i,
  /candidate[\s_.-]*(?:cv|resume|cover)/i,
  /hr[\s_.-]*confidential/i,
  /benefits[\s_.-]*enrollment/i,
];

export const OFFICE_DIRECT_UPLOAD_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const OFFICE_FILENAME_RE = /\.(?:docx|xlsx|pptx)$/i;

/**
 * MBOX parts frequently declare a generic MIME (application/octet-stream) for
 * real Office attachments, so fall back to the extension — matching on MIME
 * alone silently drops genuine deal documents.
 */
export function isOfficeAttachment(
  mime: string,
  fileName: string | null | undefined,
): boolean {
  if (OFFICE_DIRECT_UPLOAD_MIMES.has(mime)) return true;
  return !!fileName && OFFICE_FILENAME_RE.test(fileName);
}

/**
 * Soft cap for in-pipeline Haiku PDF / Office triage (~8 MB). Larger files
 * cannot be classified here, so callers must skip AFD upload (fail closed)
 * rather than uploading an untriaged file.
 */
export const PDF_TRIAGE_SOFT_MAX_BYTES = 8_000_000;

/** Max extracted Office text sent to Haiku (JS string length / UTF-16 units). */
export const OFFICE_TRIAGE_MAX_CHARS = 12_000;

/** Below this non-whitespace extract length, skip AFD (fail closed). */
export const OFFICE_TRIAGE_MIN_CHARS = 40;

/**
 * Hard domain drop for the whole message — curated employer_overrides.excluded
 * only. Personal providers (gmail, etc.) must NOT hard-drop here: align with
 * crmIngest (#367) so counterparties on free mail still reach CRM; those
 * addresses are skipped later when creating employer/correspondent cards.
 * Internal-only threads are handled by shouldSkip(dropInternalOnly).
 */
export function isDomainBlacklisted(
  headers: Headers,
  excludedDomains: Set<string> = new Set(),
): boolean {
  const from = parseAddresses(getHeader(headers, 'from'))[0]?.email ?? '';
  const domain = from.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return false;
  return excludedDomains.has(domain);
}

export function isSensitiveContent(headers: Headers): boolean {
  const subj = getHeader(headers, 'subject').toLowerCase();
  if (!subj) return false;
  return SENSITIVE_SUBJECT_PATTERNS.some((p) => subj.includes(p));
}

export function isSensitiveAttachmentFilename(filename: string | null | undefined): boolean {
  if (!filename) return false;
  return SENSITIVE_FILENAME_PATTERNS.some((re) => re.test(filename));
}

/**
 * Progressive privacy filter for the ephemeral email processor.
 * Steps 1–2 are header-first; sensitive attachment filenames are filtered
 * per-file at AFD upload time (not as a whole-email drop); step 4 is
 * existing shouldSkip (newsletter/OOO/calendar/personal/internal).
 */
export function runPrivacyFilter(
  headers: Headers,
  rawBody: string,
  opts: FilterOptions & {
    excludedDomains?: Set<string>;
    attachmentFilenames?: string[];
  } = {},
): PrivacyFilterResult {
  // 01 Domain blacklist (curated employer_overrides.excluded only)
  if (isDomainBlacklisted(headers, opts.excludedDomains ?? new Set())) {
    return { skip: true, reason: 'domain_blacklist', step: 1 };
  }

  // 02 Sensitive content (subject)
  if (isSensitiveContent(headers)) {
    return { skip: true, reason: 'sensitive_content', step: 2 };
  }

  // 03 Sensitive attachment filenames — do NOT drop the whole email here.
  // Attachment upload path filters per-file; CRM may still ingest the envelope.

  // 04 Existing noise filter (auto-reply, newsletter, calendar, personal, internal)
  const skip = shouldSkip(headers, rawBody, {
    ourDomains: opts.ourDomains ?? INTERNAL_MAIL_DOMAINS,
    dropInternalOnly: opts.dropInternalOnly ?? true,
  });
  if (skip.skip) {
    return { skip: true, reason: skip.reason, step: 4 };
  }

  return { skip: false, reason: '', step: 0 };
}

/** True when the PDF/Office bytes are too large to triage — skip AFD upload. */
export function shouldBypassPdfTriage(sizeBytes: number): boolean {
  return sizeBytes > PDF_TRIAGE_SOFT_MAX_BYTES;
}

/** Same soft-max gate as PDFs; alias for Office call sites. */
export function shouldBypassOfficeTriage(sizeBytes: number): boolean {
  return shouldBypassPdfTriage(sizeBytes);
}

/** Bound Office extract text for the triage prompt (head only). */
export function clipOfficeTriageText(text: string): string {
  if (text.length <= OFFICE_TRIAGE_MAX_CHARS) return text;
  return text.slice(0, OFFICE_TRIAGE_MAX_CHARS);
}

/** True when extract has enough non-whitespace content to classify. */
export function hasEnoughOfficeExtractText(text: string): boolean {
  const nonWs = text.replace(/\s+/g, '');
  return nonWs.length >= OFFICE_TRIAGE_MIN_CHARS;
}
