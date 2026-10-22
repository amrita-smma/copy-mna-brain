import { describe, expect, it } from 'vitest';
import { FEATURE_CATALOG } from '@/lib/features/catalog';
import {
  CONSOLE_TABS,
  CONSOLE_TAB_GROUPS,
  CONSOLE_TAB_SLUGS,
  describeConsoleTabs,
  findTabByPath,
  findTabBySlug,
  groupedConsoleTabs,
  isConsoleTabPath,
  toLogicalPath,
  visibleConsoleTabs,
} from './consoleTabs';

describe('findTabBySlug', () => {
  it('returns the matching tab', () => {
    expect(findTabBySlug('pipeline')).toMatchObject({
      path: '/pipeline',
      label: 'Pipeline',
    });
  });

  it('returns undefined for an unknown slug', () => {
    expect(findTabBySlug('nope')).toBeUndefined();
  });

  it('labels the workforce queue AI Workforce without changing its path', () => {
    expect(findTabBySlug('ai-workforce')).toMatchObject({
      path: '/ai-workforce',
      label: 'AI Workforce',
    });
  });
});

describe('findTabByPath', () => {
  it('matches an exact tab path', () => {
    expect(findTabByPath('/crm')?.slug).toBe('crm');
  });

  it('resolves a sub-route to its parent tab', () => {
    expect(findTabByPath('/pipeline/8f2c-abc')?.slug).toBe('pipeline');
  });

  it('classifies /companies/<id> as Pipeline — same view as a deal detail', () => {
    expect(findTabByPath('/companies/8f2c-abc')?.slug).toBe('pipeline');
  });

  it('returns undefined for the chat landing', () => {
    expect(findTabByPath('/')).toBeUndefined();
  });

  it('does not match a path that merely shares a prefix', () => {
    expect(findTabByPath('/crm-archive')).toBeUndefined();
  });
});

describe('isConsoleTabPath', () => {
  it('accepts a tab’s own path', () => {
    expect(isConsoleTabPath('/pipeline')).toBe(true);
  });

  // Stricter than findTabByPath on purpose: this guards paths that get trusted
  // and pushed, so a sub-route or a traversal must not pass.
  it('rejects a sub-route of a tab', () => {
    expect(isConsoleTabPath('/pipeline/8f2c-abc')).toBe(false);
  });

  it('rejects a traversal dressed up as a sub-route', () => {
    expect(isConsoleTabPath('/pipeline/../../etc')).toBe(false);
  });

  it('rejects the company-detail path — navigate_page never emits it', () => {
    expect(isConsoleTabPath('/companies/8f2c-abc')).toBe(false);
  });

  it('rejects an unknown path', () => {
    expect(isConsoleTabPath('/admin-portal')).toBe(false);
    expect(isConsoleTabPath('')).toBe(false);
  });
});

describe('toLogicalPath', () => {
  it('strips the workspace prefix', () => {
    expect(toLogicalPath('/w/togan-vcc/pipeline')).toBe('/pipeline');
  });

  it('returns / for the workspace root', () => {
    expect(toLogicalPath('/w/togan-vcc')).toBe('/');
  });

  it('leaves an already-bare path alone', () => {
    expect(toLogicalPath('/dashboard')).toBe('/dashboard');
  });
});

describe('CONSOLE_TABS', () => {
  it('has a unique slug and path per tab', () => {
    expect(new Set(CONSOLE_TAB_SLUGS).size).toBe(CONSOLE_TABS.length);
    expect(new Set(CONSOLE_TABS.map((t) => t.path)).size).toBe(CONSOLE_TABS.length);
  });

  // The tab strip gates each entry on its `flag` via the workspace feature
  // flags. A typo'd key silently defaults to visible, so assert the keys exist.
  it('gates every tab on a key that exists in the feature catalog', () => {
    const catalogKeys = new Set(FEATURE_CATALOG.map((f) => f.key));
    for (const tab of CONSOLE_TABS) {
      if (tab.flag) expect(catalogKeys, `${tab.slug} -> ${tab.flag}`).toContain(tab.flag);
    }
  });

  it('declares each path relative to the workspace, without the /w prefix', () => {
    for (const tab of CONSOLE_TABS) {
      expect(tab.path).toMatch(/^\/[a-z-]+$/);
    }
  });
});

describe('visibleConsoleTabs', () => {
  it('hides a tab whose flag is off', () => {
    const slugs = visibleConsoleTabs({ CRM_ENABLED: false }).map((t) => t.slug);
    expect(slugs).not.toContain('crm');
    expect(slugs).toContain('pipeline');
  });

  // A key the resolver has never heard of must not hide a destination — that
  // would leave the user with no way to reach the page at all.
  it('keeps tabs whose flag is absent from the map', () => {
    expect(visibleConsoleTabs({})).toEqual(CONSOLE_TABS);
  });

  it('preserves the registry’s display order', () => {
    const slugs = visibleConsoleTabs({ DASHBOARD_ENABLED: false }).map((t) => t.slug);
    expect(slugs).toEqual(CONSOLE_TAB_SLUGS.filter((s) => s !== 'dashboard'));
  });

  it('keeps only the always-on tabs when every flag is off', () => {
    const allOff = Object.fromEntries(CONSOLE_TABS.map((t) => [t.flag, false]));
    expect(visibleConsoleTabs(allOff).map((t) => t.slug)).toEqual(['bots']);
  });
});

describe('groupedConsoleTabs', () => {
  it('buckets the tabs into the sidebar sections, in registry order', () => {
    const groups = groupedConsoleTabs({});
    expect(groups.map((g) => g.id)).toEqual(CONSOLE_TAB_GROUPS.map((g) => g.id));
    expect(groups.find((g) => g.id === 'deal-flow')?.tabs.map((t) => t.slug)).toEqual([
      'dashboard',
      'sourcing',
      'pipeline',
      'master-data',
      'crm',
      'fund-management',
      'ledger',
    ]);
    expect(groups.find((g) => g.id === 'intelligence')?.tabs.map((t) => t.slug)).toEqual([
      'insight',
      'smart-files',
      'data-navigator',
      'presentation',
      'ai-workforce',
      'graph',
    ]);
  });

  // Every tab must be reachable from the nav — a tab filed under a group the
  // sidebar doesn't render would be a page with no way in.
  // The Bots section's tabs are linked from `ChatSidebar` instead.
  it('loses no visible tab', () => {
    const grouped = groupedConsoleTabs({}).flatMap((g) => g.tabs.map((t) => t.slug));
    const botSection = CONSOLE_TABS.filter((t) => t.group === 'bots').map((t) => t.slug);
    expect(botSection).toEqual(['bots']);
    expect(new Set([...grouped, ...botSection])).toEqual(new Set(CONSOLE_TAB_SLUGS));
  });

  it('leaves the Bots page out of the page-nav sections', () => {
    const grouped = groupedConsoleTabs({}).flatMap((g) => g.tabs.map((t) => t.slug));
    expect(grouped).not.toContain('bots');
  });

  it('respects feature flags', () => {
    const groups = groupedConsoleTabs({ CRM_ENABLED: false });
    expect(groups.find((g) => g.id === 'deal-flow')?.tabs.map((t) => t.slug)).not.toContain('crm');
  });

  // An empty section header that expands to nothing is worse than no header.
  it('drops a group whose every tab is flagged off', () => {
    const intelligenceOff = Object.fromEntries(
      CONSOLE_TABS.filter((t) => t.group === 'intelligence').map((t) => [t.flag, false]),
    );
    const groups = groupedConsoleTabs(intelligenceOff);
    expect(groups.map((g) => g.id)).toEqual(['deal-flow']);
  });

  it('renders no section when every flag is off', () => {
    const allOff = Object.fromEntries(CONSOLE_TABS.map((t) => [t.flag, false]));
    expect(groupedConsoleTabs(allOff)).toEqual([]);
  });
});

describe('describeConsoleTabs', () => {
  it('lists every slug for the tool description', () => {
    const described = describeConsoleTabs();
    for (const slug of CONSOLE_TAB_SLUGS) {
      expect(described).toContain(`\`${slug}\``);
    }
  });
});

describe('Data Navigator tab', () => {
  it('is registered in the intelligence group behind its own flag', () => {
    const tab = CONSOLE_TABS.find((t) => t.slug === 'data-navigator');
    expect(tab).toBeDefined();
    expect(tab?.path).toBe('/data-navigator');
    expect(tab?.group).toBe('intelligence');
    expect(tab?.flag).toBe('DATA_NAVIGATOR_ENABLED');
  });

  it('is hidden when the flag is off', () => {
    const visible = visibleConsoleTabs({ DATA_NAVIGATOR_ENABLED: false });
    expect(visible.some((t) => t.slug === 'data-navigator')).toBe(false);
  });

  it('is visible when the flag is on', () => {
    const visible = visibleConsoleTabs({ DATA_NAVIGATOR_ENABLED: true });
    expect(visible.some((t) => t.slug === 'data-navigator')).toBe(true);
  });
});
