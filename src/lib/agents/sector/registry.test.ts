import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  createSectorRegistry,
  getSectorAgent,
  isSectorAgentKey,
  listSectorAgents,
} from './registry';
import type { SectorAgentEntry } from './types';


/** Every module specifier a source file imports or re-exports. */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(join(__dirname, file), 'utf8');
  const specifiers: string[] = [];
  for (const m of src.matchAll(/(?:import|export)[^'"`;]*?from\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(m[1]);
  }
  for (const m of src.matchAll(/(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

describe('listSectorAgents', () => {
  it('ships exactly @minerba, @dikti and @bangun, none deprecated', () => {
    expect(listSectorAgents().map((a) => a.handle)).toEqual(['@minerba', '@dikti', '@bangun']);
    expect(listSectorAgents({ includeDeprecated: true })).toHaveLength(3);
  });

  it('has unique keys and handles, each handle being @ + key', () => {
    const agents = listSectorAgents({ includeDeprecated: true });
    expect(new Set(agents.map((a) => a.key)).size).toBe(agents.length);
    expect(new Set(agents.map((a) => a.handle)).size).toBe(agents.length);
    for (const a of agents) expect(a.handle).toBe(`@${a.key}`);
  });

  it('gives every agent a name, sector, and one-line description', () => {
    for (const a of listSectorAgents()) {
      expect(a.name.trim()).not.toBe('');
      expect(a.sector.trim()).not.toBe('');
      expect(a.description.trim()).not.toBe('');
      expect(a.description).not.toContain('\n');
    }
  });

  it('returns copies so a caller cannot mutate the registry', () => {
    listSectorAgents()[0].name = 'tampered';
    expect(listSectorAgents()[0].name).toBe('Mining and Minerals Agent');
  });
});

describe('getSectorAgent', () => {
  it('resolves a shipped agent by key, and undefined for an unknown key', () => {
    expect(getSectorAgent('dikti')?.handle).toBe('@dikti');
    expect(getSectorAgent('nope')).toBeUndefined();
  });
});

describe('isSectorAgentKey', () => {
  it('accepts registry keys and rejects anything else', () => {
    expect(isSectorAgentKey('minerba')).toBe(true);
    expect(isSectorAgentKey('@minerba')).toBe(false);
    expect(isSectorAgentKey('mna')).toBe(false);
    expect(isSectorAgentKey(undefined)).toBe(false);
    expect(isSectorAgentKey(42)).toBe(false);
  });
});

describe('createSectorRegistry deprecation', () => {
  const fixture: SectorAgentEntry[] = [
    {
      key: 'minerba',
      handle: '@minerba',
      name: 'Old Mining',
      sector: 'Mining and minerals',
      description: 'Deprecated fixture.',
      deprecated: true,
      successorKey: 'bangun',
    },
    {
      key: 'bangun',
      handle: '@bangun',
      name: 'Construction',
      sector: 'Construction and property development',
      description: 'Live fixture.',
      deprecated: false,
    },
  ];
  const registry = createSectorRegistry(fixture);

  it('hides a deprecated agent from new bindings, but lists it when asked', () => {
    expect(registry.listSectorAgents().map((a) => a.key)).toEqual(['bangun']);
    expect(registry.listSectorAgents({ includeDeprecated: true }).map((a) => a.key)).toEqual(['minerba', 'bangun']);
  });

  it('still resolves a deprecated agent by key, with its successor', () => {
    const entry = registry.getSectorAgent('minerba');
    expect(entry?.deprecated).toBe(true);
    expect(entry?.successorKey).toBe('bangun');
    expect(registry.isSectorAgentKey('minerba')).toBe(true);
  });
});

describe('registry module dependencies', () => {
  // Routes, the binding UI and the workforce body import the registry. The
  // workforce body runs in a sandbox with no `require`, so a LangChain (or tool
  // module) import reachable from here would kill every run.
  it('registry.ts imports nothing but ./types, and types.ts imports nothing', () => {
    expect(importSpecifiers('registry.ts')).toEqual(['./types', './types']);
    expect(importSpecifiers('types.ts')).toEqual([]);
    // The scanner sees real imports, so the above is not a vacuous pass.
    expect(importSpecifiers('registry.test.ts')).toContain('vitest');
  });
});
