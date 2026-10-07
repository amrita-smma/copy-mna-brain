/**
 * Generates `docs/architecture/code-map.md` — the mechanical inventory of this
 * codebase (routes, services, repositories, agents, jobs, flags, pages).
 *
 * Why this is generated and `ARCHITECTURE.md` is not: the hand-written doc
 * explains *shape* — the layering, the request path, where a new thing goes —
 * and changes a few times a year. The inventory is *facts* — 190 route files,
 * 77 services — and changes every week. A hand-maintained inventory is wrong
 * within a sprint, and a wrong map is worse than no map, so this one is derived
 * from the filesystem instead.
 *
 *   pnpm arch:map          regenerate the map
 *   pnpm arch:map:check    exit 1 if the committed map is stale (CI)
 *
 * Deliberately regex-based rather than TypeScript-AST-based: the map needs
 * names and paths, not semantics, and staying dependency-free means it runs in
 * CI without a compile step. A parse miss degrades one table row, never the run.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const OUT = 'docs/architecture/code-map.md';

/** Tracked files matching a glob, relative to the repo root. Sorted for stable output. */
function tracked(...globs: string[]): string[] {
  const out = execFileSync('git', ['ls-files', ...globs], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

const read = (f: string): string => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

const isTest = (f: string): boolean => /\.test\.tsx?$/.test(f);

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface RouteRow {
  url: string;
  file: string;
  methods: string[];
  services: string[];
}

function collectRoutes(): RouteRow[] {
  return tracked('src/app/api/**/route.ts')
    .filter((f) => !isTest(f))
    .map((file) => {
      const src = read(file);
      const methods = HTTP_METHODS.filter((m) =>
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src),
      );
      // A route reaches the container one of two ways. Both are read, because
      // a service silently missing from the map is worse than no map at all.
      const services = new Set<string>();

      // 1. `const { companyService, fileService } = createContainer(...)`
      for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*createContainer\(/g)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(':')[0].trim();
          if (name) services.add(name);
        }
      }

      // 2. `const container = createContainer(...)` then `container.fooService`
      for (const m of src.matchAll(
        /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?createContainer\(/g,
      )) {
        const binding = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const use of src.matchAll(new RegExp(`\\b${binding}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
          services.add(use[1]);
        }
      }
      const url = file
        .replace(/^src\/app/, '')
        .replace(/\/route\.ts$/, '')
        .replace(/\/\((?:[^/]*)\)/g, ''); // strip Next.js route groups
      return { url, file, methods, services: [...services].sort() };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

// ---------------------------------------------------------------------------
// Services / repositories
// ---------------------------------------------------------------------------

interface ClassRow {
  file: string;
  classes: string[];
  tested: boolean;
}

/**
 * Deliberately records no line counts. Every field in this map must change
 * only when the *structure* changes — a file added, removed, renamed, or newly
 * tested. A line count changes on every content edit, which would make the map
 * stale on merges that add nothing to it, and (because CI checks the PR's
 * merge commit) break the check on every open PR each time main moves.
 */
function collectClasses(dir: string): ClassRow[] {
  return tracked(`${dir}/*.ts`)
    .filter((f) => !isTest(f) && !f.endsWith('/index.ts'))
    .map((file) => {
      const classes = [...read(file).matchAll(/^export\s+class\s+([A-Za-z0-9_]+)/gm)].map(
        (m) => m[1],
      );
      return { file, classes, tested: existsSync(file.replace(/\.ts$/, '.test.ts')) };
    });
}

/** Service keys exposed on the `Container` interface in `container.ts`. */
function collectContainerKeys(): string[] {
  const src = read('src/lib/services/container.ts');
  const block = /export interface Container\s*\{([\s\S]*?)\n\}/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]).sort();
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

interface AgentRow {
  name: string;
  toolCount: number;
  toolsTested: number;
  hasEntrypoint: boolean;
}

function collectAgents(): AgentRow[] {
  const dirs = new Set(
    tracked('src/lib/agents/**/*.ts')
      .map((f) => f.split('/')[3])
      .filter((d) => d && !d.endsWith('.ts')),
  );
  return [...dirs].sort().map((name) => {
    const toolFiles = tracked(`src/lib/agents/${name}/tools/*.ts`).filter(
      (f) => !isTest(f) && !f.endsWith('/index.ts'),
    );
    return {
      name,
      toolCount: toolFiles.length,
      toolsTested: toolFiles.filter((f) => existsSync(f.replace(/\.ts$/, '.test.ts'))).length,
      hasEntrypoint: existsSync(`src/lib/agents/${name}/index.ts`),
    };
  });
}

// ---------------------------------------------------------------------------
// Jobs / flags / pages
// ---------------------------------------------------------------------------

function collectJobHandlers(): string[] {
  return tracked('src/lib/jobs/handlers/*.ts')
    .filter((f) => !isTest(f) && !f.endsWith('/index.ts'))
    .map((f) => f.replace('src/lib/jobs/handlers/', '').replace('.ts', ''));
}

function collectJobTypes(): string[] {
  const src = read('src/lib/db/schema.ts');
  const m = /export const jobType = pgEnum\(\s*"job_type",\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function collectFlags(): { fn: string; envVar: string }[] {
  const src = read('src/lib/flags.ts');
  return [...src.matchAll(/export const ([a-zA-Z0-9_]+) = booleanFlag\("([^"]+)"\)/g)]
    .map((m) => ({ fn: m[1], envVar: m[2] }))
    .sort((a, b) => a.fn.localeCompare(b.fn));
}

function collectPages(): { url: string; renders: string }[] {
  return tracked('src/app/**/page.tsx')
    .map((file) => {
      const src = read(file);
      const url =
        file.replace(/^src\/app/, '').replace(/\/page\.tsx$/, '').replace(/\/\([^/]*\)/g, '') || '/';

      // Pre-`/w/<slug>` deeplinks that only bounce to the workspace-scoped
      // route. Called out so nobody "fixes" a page by editing the redirect.
      if (src.includes('redirectToWorkspaceScoped')) {
        return { url, renders: '_legacy redirect → `/w/[workspaceSlug]` equivalent_' };
      }
      // The view a page delegates to — the thing you actually want to open.
      const view = /from\s+["']@\/views\/([A-Za-z0-9/_-]+)["']/.exec(src);
      if (view) return { url, renders: `\`src/views/${view[1]}.tsx\`` };

      return { url, renders: `_inline — see \`${file}\`_` };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const table = (headers: string[], rows: string[][]): string =>
  [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

function render(): string {
  const routes = collectRoutes();
  const services = collectClasses('src/lib/services');
  const repositories = collectClasses('src/lib/repositories');
  const containerKeys = collectContainerKeys();
  const agents = collectAgents();
  const handlers = collectJobHandlers();
  const jobTypes = collectJobTypes();
  const flags = collectFlags();
  const pages = collectPages();
  const migrations = tracked('drizzle/migrations/*.sql');
  const pipelineMigrations = tracked('data-pipeline/migrations/*.sql');

  const untested = (rows: ClassRow[]) => rows.filter((r) => !r.tested).map((r) => r.file);

  return `<!-- GENERATED BY scripts/build-code-map.ts — DO NOT EDIT BY HAND. Run \`pnpm arch:map\`. -->

# Code map

A generated inventory of every route, service, repository, agent, job and flag
in this repo. Regenerate with \`pnpm arch:map\`; CI fails if it is stale.

**Start at [\`ARCHITECTURE.md\`](../../ARCHITECTURE.md)** — it explains how these
pieces fit together and where new code goes. This file is the lookup table.

## At a glance

${table(
  ['Layer', 'Count', 'Where'],
  [
    ['API routes', String(routes.length), '`src/app/api/**/route.ts`'],
    ['Services', String(services.length), '`src/lib/services/`'],
    ['Repositories', String(repositories.length), '`src/lib/repositories/`'],
    ['Agents', String(agents.length), '`src/lib/agents/`'],
    ['Job handlers', String(handlers.length), '`src/lib/jobs/handlers/`'],
    ['Feature flags', String(flags.length), '`src/lib/flags.ts`'],
    ['Pages', String(pages.length), '`src/app/**/page.tsx`'],
    ['Migrations (app)', String(migrations.length), '`drizzle/migrations/`'],
    ['Migrations (pipeline)', String(pipelineMigrations.length), '`data-pipeline/migrations/`'],
  ],
)}

## Feature flags

Resolve server-side in a page file, pass down as boolean props. See
\`.claude/CLAUDE.md\` → Feature Flags.

${table(
  ['Flag function', 'Env var'],
  flags.map((f) => [`\`${f.fn}\``, `\`${f.envVar}\``]),
)}

## Pages → views

${table(
  ['Route', 'Renders'],
  pages.map((p) => [`\`${p.url}\``, p.renders]),
)}

## API routes

Methods each handler exports, and the container services it pulls. A route with
no listed service either takes none or resolves it indirectly — open the file.

${table(
  ['Route', 'Methods', 'Services'],
  routes.map((r) => [
    `\`${r.url}\``,
    r.methods.join(', ') || '—',
    r.services.length ? r.services.map((s) => `\`${s}\``).join(', ') : '—',
  ]),
)}

## Services

\`Container\` exposes ${containerKeys.length} keys. Wire new services in
\`src/lib/services/container.ts\`.

${table(
  ['File', 'Exported classes', 'Tests'],
  services.map((s) => [
    `\`${s.file.replace('src/lib/services/', '')}\``,
    s.classes.map((c) => `\`${c}\``).join(', ') || '—',
    s.tested ? '✅' : '❌',
  ]),
)}

${
  untested(services).length
    ? `**Services with no \`.test.ts\`:** ${untested(services)
        .map((f) => `\`${f.replace('src/lib/services/', '')}\``)
        .join(', ')}`
    : '**Every service has a test file.**'
}

## Repositories

Workspace-scoped Drizzle data access. The only layer allowed to touch the DB.

${table(
  ['File', 'Exported classes', 'Tests'],
  repositories.map((r) => [
    `\`${r.file.replace('src/lib/repositories/', '')}\``,
    r.classes.map((c) => `\`${c}\``).join(', ') || '—',
    r.tested ? '✅' : '❌',
  ]),
)}

${
  untested(repositories).length
    ? `**Repositories with no \`.test.ts\`:** ${untested(repositories)
        .map((f) => `\`${f.replace('src/lib/repositories/', '')}\``)
        .join(', ')}`
    : '**Every repository has a test file.**'
}

## Agents

One folder per agent, \`index.ts\` entrypoint using \`createAgent\`, one file per
tool under \`tools/\`. See \`.claude/CLAUDE.md\` → Agent Design Pattern.

${table(
  ['Agent', 'Tools', 'Tools with tests', 'Has `index.ts`'],
  agents.map((a) => [
    `\`${a.name}\``,
    String(a.toolCount),
    `${a.toolsTested}/${a.toolCount}`,
    a.hasEntrypoint ? '✅' : '❌',
  ]),
)}

## Async jobs

Queue work through \`JobDispatcher\`; never block a request on slow I/O.

**\`job_type\` enum (\`src/lib/db/schema.ts\`):** ${
    jobTypes.length ? jobTypes.map((t) => `\`${t}\``).join(', ') : '—'
  }

**Handlers (\`src/lib/jobs/handlers/\`):** ${handlers.map((h) => `\`${h}\``).join(', ')}
`;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const next = render();
const check = process.argv.includes('--check');

/**
 * First differing lines, so a CI failure says *what* drifted rather than just
 * that something did. Line-wise rather than a real diff algorithm — the map is
 * generated, so differences are small and positional.
 */
function firstDifferences(a: string, b: string, limit = 20): string[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(x.length, y.length) && out.length < limit; i++) {
    if (x[i] !== y[i]) {
      if (x[i] !== undefined) out.push(`  - [${i + 1}] ${x[i]}`);
      if (y[i] !== undefined) out.push(`  + [${i + 1}] ${y[i]}`);
    }
  }
  return out;
}

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== next) {
    const diff = firstDifferences(current, next);
    console.error(
      `✗ ${OUT} is out of date.\n` +
        `  The code map is generated from the filesystem, so a new route, service,\n` +
        `  repository, agent, job or flag makes it stale.\n` +
        `  Fix: run \`pnpm arch:map\` and commit the result.\n\n` +
        `  committed (-) vs generated here (+):\n${diff.join('\n')}` +
        (diff.length >= 20 ? '\n  …truncated' : ''),
    );
    process.exit(1);
  }
  console.log(`✓ ${OUT} is up to date.`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(join(process.cwd(), OUT), next);
  console.log(`✓ wrote ${OUT}`);
}
