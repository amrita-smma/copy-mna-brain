import { describe, expect, it } from 'vitest';
import {
  NAVIGATE_PAGE_MARKER,
  parseNavigatePayloads,
  resolveNavigationAction,
  stripNavigateMarkers,
  type NavigatePagePayload,
} from './navigateAction';

const payload = {
  nav_id: 'nav-1',
  slug: 'pipeline',
  path: '/pipeline',
  label: 'Pipeline',
  reason: 'to review the stalled deals',
};

function marker(body: unknown) {
  return `<!-- ${NAVIGATE_PAGE_MARKER}:${JSON.stringify(body)} -->`;
}

describe('parseNavigatePayloads', () => {
  it('extracts a payload from a tool output', () => {
    const content = `Opened **Pipeline** in the center console.\n\n${marker(payload)}`;
    expect(parseNavigatePayloads(content)).toEqual([payload]);
  });

  it('returns every payload in order when a turn emitted several', () => {
    const second = { ...payload, nav_id: 'nav-2', slug: 'crm', path: '/crm', label: 'CRM' };
    const found = parseNavigatePayloads(`${marker(payload)}\n${marker(second)}`);
    expect(found.map((p) => p.nav_id)).toEqual(['nav-1', 'nav-2']);
  });

  // A shared global regex would keep `lastIndex` between calls and skip matches
  // on the second pass — this transcript is re-scanned on every render.
  it('finds the same payload on repeated scans', () => {
    const content = marker(payload);
    expect(parseNavigatePayloads(content)).toHaveLength(1);
    expect(parseNavigatePayloads(content)).toHaveLength(1);
  });

  it('returns [] for content with no marker', () => {
    expect(parseNavigatePayloads('Just a normal answer.')).toEqual([]);
  });

  it('skips a malformed marker instead of throwing', () => {
    expect(parseNavigatePayloads(`<!-- ${NAVIGATE_PAGE_MARKER}:{not json} -->`)).toEqual([]);
  });

  it('skips a payload missing required fields', () => {
    expect(parseNavigatePayloads(marker({ nav_id: 'nav-1' }))).toEqual([]);
    expect(parseNavigatePayloads(marker({ path: '/crm', label: 'CRM' }))).toEqual([]);
  });

  // The path is read back out of persisted chat history and handed to
  // router.push, so a corrupted or tampered row must not be able to steer
  // navigation off the console tabs.
  it('rejects a path that is not a console tab', () => {
    expect(parseNavigatePayloads(marker({ ...payload, path: '/admin-portal' }))).toEqual([]);
    expect(parseNavigatePayloads(marker({ ...payload, path: 'https://evil.example' }))).toEqual([]);
    expect(parseNavigatePayloads(marker({ ...payload, path: '/pipeline/../../etc' }))).toEqual([]);
  });

  it('accepts every real console tab path', () => {
    for (const path of ['/dashboard', '/pipeline', '/crm', '/fund-management', '/graph']) {
      expect(parseNavigatePayloads(marker({ ...payload, path })), path).toHaveLength(1);
    }
  });
});

describe('resolveNavigationAction', () => {
  const nav = (id: string, path = '/pipeline'): NavigatePagePayload => ({
    nav_id: id,
    slug: 'pipeline',
    path,
    label: 'Pipeline',
    reason: 'r',
  });

  // The bug this rule exists to prevent: opening an old chat that contains a
  // navigate_page must not move the console.
  it('absorbs everything and navigates nowhere on the first view of a chat', () => {
    const result = resolveNavigationAction({
      navigations: [nav('a'), nav('b')],
      handled: new Set(),
      isFirstViewOfChat: true,
      isLiveTurn: true,
    });
    expect(result.navigateTo).toBeNull();
    expect(result.absorb).toEqual(['a', 'b']);
  });

  it('navigates for an id that arrives after the first view', () => {
    const result = resolveNavigationAction({
      navigations: [nav('a'), nav('b')],
      handled: new Set(['a']),
      isFirstViewOfChat: false,
      isLiveTurn: true,
    });
    expect(result.navigateTo?.nav_id).toBe('b');
    expect(result.absorb).toEqual(['b']);
  });

  it('does nothing when every id is already handled — the re-render case', () => {
    const result = resolveNavigationAction({
      navigations: [nav('a'), nav('b')],
      handled: new Set(['a', 'b']),
      isFirstViewOfChat: false,
      isLiveTurn: true,
    });
    expect(result.navigateTo).toBeNull();
    expect(result.absorb).toEqual([]);
  });

  // Intermediate pushes would only stack junk onto the history stack.
  it('navigates to the last of several pending ids', () => {
    const result = resolveNavigationAction({
      navigations: [nav('a', '/crm'), nav('b', '/graph')],
      handled: new Set(),
      isFirstViewOfChat: false,
      isLiveTurn: true,
    });
    expect(result.navigateTo?.path).toBe('/graph');
    expect(result.absorb).toEqual(['a', 'b']);
  });

  it('does nothing for an empty transcript', () => {
    expect(
      resolveNavigationAction({
        navigations: [],
        handled: new Set(),
        isFirstViewOfChat: false,
        isLiveTurn: true,
      }),
    ).toEqual({ absorb: [], navigateTo: null });
  });

  // Walks the real sequence: load a chat with history, then a live turn.
  it('suppresses history on load then fires once for the next live call', () => {
    const handled = new Set<string>();
    const history = [nav('old-1'), nav('old-2')];

    const onLoad = resolveNavigationAction({
      navigations: history,
      handled,
      isFirstViewOfChat: true,
      isLiveTurn: false,
    });
    onLoad.absorb.forEach((id) => handled.add(id));
    expect(onLoad.navigateTo).toBeNull();

    const live = resolveNavigationAction({
      navigations: [...history, nav('fresh')],
      handled,
      isFirstViewOfChat: false,
      isLiveTurn: true,
    });
    live.absorb.forEach((id) => handled.add(id));
    expect(live.navigateTo?.nav_id).toBe('fresh');

    // A re-render of that same transcript must not navigate again.
    const rerender = resolveNavigationAction({
      navigations: [...history, nav('fresh')],
      handled,
      isFirstViewOfChat: false,
      isLiveTurn: true,
    });
    expect(rerender.navigateTo).toBeNull();
  });

  // ChatProvider polls a resumed chat while status is `ready`. A tool result
  // that was missing from the first fetch must be absorbed, not replayed.
  it('absorbs new ids without navigating when the turn is not live', () => {
    const result = resolveNavigationAction({
      navigations: [nav('old'), nav('late')],
      handled: new Set(['old']),
      isFirstViewOfChat: false,
      isLiveTurn: false,
    });
    expect(result.navigateTo).toBeNull();
    expect(result.absorb).toEqual(['late']);
  });
});

describe('stripNavigateMarkers', () => {
  it('removes the marker and the whitespace ahead of it', () => {
    const stripped = stripNavigateMarkers(`Opened **Pipeline**.\n\n${marker(payload)}`);
    expect(stripped).toBe('Opened **Pipeline**.');
  });

  it('removes every marker', () => {
    expect(stripNavigateMarkers(`${marker(payload)}${marker(payload)}`)).toBe('');
  });

  it('leaves unrelated content untouched', () => {
    expect(stripNavigateMarkers('No markers here.')).toBe('No markers here.');
  });
});
