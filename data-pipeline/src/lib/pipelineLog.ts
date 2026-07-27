/**
 * Pipeline logging standard for the ephemeral email path.
 * Never log subject, body, addresses, or raw headers — only ids, counts, reasons.
 */

export type PipelineLogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

const FORBIDDEN_KEY =
  /^(subject|body|body_text|body_snippet|from|to|cc|bcc|address|email|raw_headers|headers|content)$/i;

function sanitizeFields(fields?: PipelineLogFields): PipelineLogFields | undefined {
  if (!fields) return undefined;
  const out: PipelineLogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEY.test(k)) continue;
    // Allow hashed / id-like keys even if they contain "email" as substring of custodian_hash
    if (/email/i.test(k) && !/_id$|_hash$|count$/i.test(k) && k !== 'custodian_hash') {
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function pipelineLog(
  scope: string,
  message: string,
  fields?: PipelineLogFields,
): void {
  const safe = sanitizeFields(fields);
  if (safe && Object.keys(safe).length > 0) {
    console.log(`[${scope}] ${message} ${JSON.stringify(safe)}`);
  } else {
    console.log(`[${scope}] ${message}`);
  }
}

export function pipelineError(
  scope: string,
  message: string,
  err?: unknown,
  fields?: PipelineLogFields,
): void {
  const safe = sanitizeFields(fields) ?? {};
  const errMsg = err instanceof Error ? err.message : err != null ? String(err) : undefined;
  // Strip likely PII from error strings (angles / bare emails)
  const scrubbed = errMsg
    ?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    ?.slice(0, 300);
  console.error(
    `[${scope}] ${message} ${JSON.stringify({ ...safe, error: scrubbed })}`,
  );
}

/** Stable non-reversible label for a custodian in logs. */
export function custodianHash(custodianEmail: string): string {
  let h = 0;
  for (let i = 0; i < custodianEmail.length; i++) {
    h = (Math.imul(31, h) + custodianEmail.charCodeAt(i)) | 0;
  }
  return `c${(h >>> 0).toString(16)}`;
}
