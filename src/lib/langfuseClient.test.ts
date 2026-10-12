import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * `runAgent`'s `'use workflow'` body drains the Langfuse queue in its `finally`,
 * so whatever it imports is compiled into the WDK workflow bundle — and that
 * bundle fails to build on any use of a `node:` builtin inside a module it
 * contains, reachable from the workflow body or not.
 *
 * That is why `flushLangfuse` lives in `@/lib/langfuseClient` rather than in the
 * `@/lib/langfuse` barrel, which reaches the AsyncLocalStorage in
 * `@/lib/langfuseUser`. The split is invisible at the call site: adding
 * `import { getLangfuseUserId } from './langfuseUser'` here would look entirely
 * reasonable and would break `next build` with `workflow-node-module-error`,
 * which is a slow and confusing way to find out. Hence this test.
 */
const SRC = resolve(__dirname, '..');

/** Static import specifiers in a module's source, in order. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** Resolve a relative or `@/`-aliased specifier to a file under `src/`, or null. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // Not this shape; try the next.
    }
  }
  return null;
}

/** Every first-party module reachable from `entry` by static import. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      const local = resolveLocal(specifier, file);
      if (local && !seen.has(local)) queue.push(local);
    }
  }
  return [...seen];
}

describe('langfuseClient (the module a WDK workflow body may import)', () => {
  it('reaches no node: builtin, so the workflow bundle still builds', () => {
    const offenders = moduleGraph(resolve(SRC, 'lib/langfuseClient.ts'))
      .filter((file) => importsOf(file).some((s) => s.startsWith('node:')))
      .map((file) => file.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('does not reach the user store, which is where a node: builtin would come from', () => {
    const graph = moduleGraph(resolve(SRC, 'lib/langfuseClient.ts'));

    expect(graph).not.toContain(resolve(SRC, 'lib/langfuseUser.ts'));
  });

  it('guards a real constraint: the langfuse barrel does reach that store', () => {
    // Without this the two assertions above would still pass if `langfuseUser`
    // stopped using AsyncLocalStorage, quietly turning them into no-ops.
    const graph = moduleGraph(resolve(SRC, 'lib/langfuse.ts'));

    expect(graph).toContain(resolve(SRC, 'lib/langfuseUser.ts'));
    expect(importsOf(resolve(SRC, 'lib/langfuseUser.ts'))).toContain('node:async_hooks');
  });
});
