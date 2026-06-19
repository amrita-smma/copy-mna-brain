import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';

const g = globalThis as unknown as { __neo4jDriver?: Driver };

export function createNeo4jDriver(): Driver {
  if (g.__neo4jDriver) return g.__neo4jDriver;

  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER ?? 'neo4j';
  const password = process.env.NEO4J_PASSWORD ?? 'password';

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    logging: { level: 'warn', logger: (level, message) => console[level]('[neo4j]', message) },
  });

  g.__neo4jDriver = driver;
  return driver;
}

export type { Driver };
