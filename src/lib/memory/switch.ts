/**
 * The two operator-level switches for CoPilot memory.
 *
 * Deliberately a module with NO imports. `@/lib/flags` needs the deployment
 * kill-switch, and `@/lib/flags` is imported by nearly every route — so reading
 * it from `./client` would drag that module's graph (and through
 * `@/lib/bedrock`, the whole `@aws-sdk/client-bedrock-runtime` package) into
 * every one of them. These are two `process.env` reads; they should cost
 * nothing to import.
 *
 * `./client` re-exports both, so callers that already need the mem0 client
 * keep importing from one place.
 */

/**
 * The deployment-wide kill-switch. On unless `COPILOT_MEMORY_ENABLED` is
 * explicitly `"false"`.
 *
 * Deliberately not a `booleanFlag` and absent from `FEATURE_CATALOG`: memory is
 * a per-user setting (`users.copilot_memory_enabled`), not a per-workspace one,
 * so there must be no admin-portal toggle that turns it off for one workspace's
 * members.
 */
export function memoryDeploymentEnabled(): boolean {
  return process.env.COPILOT_MEMORY_ENABLED !== 'false';
}

/**
 * Whether memory can run at all on this deployment: the kill-switch is on AND
 * there is a model to extract with. Both are operator-level — nothing a user
 * can change — so they collapse into one answer for the UI.
 */
export function memoryConfigured(): boolean {
  return memoryDeploymentEnabled() && Boolean(process.env.ANTHROPIC_API_KEY);
}
