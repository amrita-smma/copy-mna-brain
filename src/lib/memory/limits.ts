/**
 * The size limits on an import, in a module with NO imports.
 *
 * They are shared by `UserMemoryService` and by the `@memory_import` agent's
 * tool schema. Keeping them here breaks a real cycle: the service imports
 * `runMemoryImport`, the agent's tool imports the limits, and when those limits
 * lived on the service the three formed a loop that threw
 * `Cannot access '…' before initialization` at module-eval time. The unit tests
 * did not see it — only `next build` collecting route configuration did.
 */

/**
 * Longest source text an import accepts, in characters. Beyond this the
 * extraction call stops being reliable and the request stops being a request.
 */
export const MAX_IMPORT_CHARS = 100_000;

/** Statements one import may propose or save. Keeps one paste from being a fan-out. */
export const MAX_IMPORT_STATEMENTS = 200;

/**
 * Longest a single imported statement may be.
 *
 * The chat extraction gate caps its own facts at 200 characters; this is the
 * equivalent ceiling for the import path, enforced on the confirm write rather
 * than only in the agent's schema — the review step lets the user retype an
 * entry, so the schema's limit is not the last word on what gets stored.
 */
export const MAX_IMPORT_STATEMENT_CHARS = 500;
