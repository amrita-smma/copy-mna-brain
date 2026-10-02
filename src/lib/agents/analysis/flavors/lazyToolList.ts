/**
 * Why every tool list in this folder is built lazily.
 *
 * `tools/index.ts` sits in an import cycle with the rest of the app: a tool
 * imports a service or a job handler (`analyze_stalled_deals` → services,
 * `run_market_screening` → jobs/handlers), and those import
 * `@/lib/agents/analysis` back. The cycle is legitimate — chat tools do real
 * work — and the modules on it only *use* their imports inside functions, so it
 * resolves at runtime.
 *
 * A module-scope `[...tools]` does not. Entering the cycle anywhere can leave
 * `tools/index.ts` half-initialized while a flavor module evaluates, and
 * spreading it then throws `ReferenceError: Cannot access '…' before
 * initialization` — at Next build time, when page data is collected, not in
 * vitest (which mocks the tools barrel).
 *
 * So a flavor holds a *factory*. The arrays are read on the first call, by
 * which point every module has finished evaluating, and memoized after that so
 * a flavor's list is one stable array — `getAgentGraph` caches graphs by
 * flavor, and `withoutTools` filters a copy.
 */
import type { ToolList } from "./types";

export type ToolListFactory = () => ToolList;

/** Build a tool list on first call, then hand back the same array forever. */
export function lazyToolList(build: () => ToolList): ToolListFactory {
  let cached: ToolList | undefined;
  return () => (cached ??= build());
}
