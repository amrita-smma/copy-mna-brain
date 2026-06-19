import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';

const g = globalThis as unknown as { __neo4jDriver?: Driver };

interface Neo4jConnection {
  uri: string;
  user: string;
  password: string;
}

/**
 * Resolve Neo4j connection details.
 *
 * Prefers a single `NEO4J_URL` connection string that embeds URL-encoded
 * credentials, e.g. `bolt://neo4j:p%40ss%21word@host:7687`. This avoids the
 * shell/deployment-platform mangling that breaks passwords containing special
 * characters (`) = ! } # ...`) when stored as separate env vars.
 *
 * Falls back to the legacy `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` trio
 * (used by local Docker dev) when `NEO4J_URL` is not set.
 */
export function resolveNeo4jConnection(): Neo4jConnection {
  const url = process.env.NEO4J_URL;
  if (url) {
    const parsed = new URL(url);
    const user = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    // neo4j-driver rejects credentials embedded in the URI, so strip them.
    parsed.username = '';
    parsed.password = '';
    // `new URL` leaves a trailing `/` and bare `@`; rebuild a clean bolt URI.
    const uri = `${parsed.protocol}//${parsed.host}`;
    return { uri, user, password };
  }

  return {
    uri: process.env.NEO4J_URI ?? 'bolt://localhost:7687',
    user: process.env.NEO4J_USER ?? 'neo4j',
    password: process.env.NEO4J_PASSWORD ?? 'password',
  };
}

export function createNeo4jDriver(): Driver {
  if (g.__neo4jDriver) return g.__neo4jDriver;

  const { uri, user, password } = resolveNeo4jConnection();

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    logging: { level: 'warn', logger: (level, message) => console[level]('[neo4j]', message) },
  });

  g.__neo4jDriver = driver;
  return driver;
}

export type { Driver };
