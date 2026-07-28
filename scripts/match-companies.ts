/**
 * Company Matching — historically filled `employers.industry` by asking an LLM
 * to read each banker's email subject + body and cross-reference pipeline deals.
 *
 * MB-473 dropped `analytics.emails.subject` / `body_text`, and `raw_emails` is
 * already gone, so there is no durable email text left to drive matching.
 * This script now exits with an error instead of calling the LLM on empty prompts.
 *
 * Usage (will exit 1):
 *   pnpm match-companies
 */

console.error(
  'error: match-companies can no longer run — durable email subject/body ' +
    'were dropped from analytics.emails (MB-473) and analytics.raw_emails ' +
    'is gone. There is no email text left for industry matching.',
);
process.exit(1);
