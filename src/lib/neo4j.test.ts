import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveNeo4jConnection } from './neo4j';

describe('resolveNeo4jConnection', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.NEO4J_URL;
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USER;
    delete process.env.NEO4J_PASSWORD;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('parses URL-encoded credentials from NEO4J_URL and strips them from the URI', () => {
    process.env.NEO4J_URL = 'bolt://neo4j:gL)%3D!v%3Dq05tEydZMki%7D9py4_2PVkIqox@16.79.68.112:7687';

    expect(resolveNeo4jConnection()).toEqual({
      uri: 'bolt://16.79.68.112:7687',
      user: 'neo4j',
      password: 'gL)=!v=q05tEydZMki}9py4_2PVkIqox',
    });
  });

  it('decodes special characters in both user and password', () => {
    process.env.NEO4J_URL =
      'bolt://mnabrainneo4j:3Wkz0%5B%3D%24%23%7B5KA%3D-N(nt9Xsx5(h0mpv4A@16.79.135.50:7687';

    const conn = resolveNeo4jConnection();
    expect(conn.user).toBe('mnabrainneo4j');
    expect(conn.password).toBe('3Wkz0[=$#{5KA=-N(nt9Xsx5(h0mpv4A');
    expect(conn.uri).toBe('bolt://16.79.135.50:7687');
  });

  it('falls back to the legacy URI/USER/PASSWORD trio when NEO4J_URL is unset', () => {
    process.env.NEO4J_URI = 'bolt://example:7687';
    process.env.NEO4J_USER = 'someuser';
    process.env.NEO4J_PASSWORD = 'somepass';

    expect(resolveNeo4jConnection()).toEqual({
      uri: 'bolt://example:7687',
      user: 'someuser',
      password: 'somepass',
    });
  });

  it('defaults to local bolt credentials when nothing is configured', () => {
    expect(resolveNeo4jConnection()).toEqual({
      uri: 'bolt://localhost:7687',
      user: 'neo4j',
      password: 'password',
    });
  });
});
