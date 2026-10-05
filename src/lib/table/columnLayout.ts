/**
 * Pure, framework-agnostic logic for per-table column layout: ordering, hiding,
 * and collapsible column groups. All functions are side-effect free and
 * immutable so they can be unit-tested in isolation and reused by the React
 * `useColumnLayout` hook.
 *
 * A "group" is a set of contiguous columns with a *leader* — the leftmost
 * member in display order. When the group is collapsed, only the leader stays
 * visible and the remaining members are hidden behind the leader's expand
 * toggle. Members are always kept contiguous in the display order; a group
 * whose members become non-contiguous is automatically dissolved by
 * `normalize`.
 */

export interface ColumnGroup {
  /** Stable id (e.g. `group-<n>`). */
  id: string;
  /** Column ids that belong to this group, in display order. */
  columnIds: string[];
  /** When true, the group's columns are hidden behind a "+" marker. */
  collapsed: boolean;
}

export interface ColumnLayoutState {
  /** Every known column id, in display order (left → right). */
  order: string[];
  /** Column ids explicitly hidden (via the gear config / right-click). */
  hidden: string[];
  /** Collapsible column groups. */
  groups: ColumnGroup[];
}

const uniq = (ids: string[]): string[] => Array.from(new Set(ids));

/**
 * Reconcile a (possibly stale) stored layout against the current set of column
 * ids. A column that is new since the layout was saved is placed right after
 * its nearest declared predecessor (after that predecessor's whole group, so a
 * group is never split), or first when nothing declared precedes it. Ids that
 * no longer exist are dropped from order/hidden/groups. Always returns a valid
 * state.
 */
export function initLayout(
  allIds: string[],
  stored?: Partial<ColumnLayoutState> | null,
): ColumnLayoutState {
  const known = new Set(allIds);
  const order = uniq((stored?.order ?? []).filter((id) => known.has(id)));

  const hidden = uniq((stored?.hidden ?? []).filter((id) => known.has(id)));

  const groups = (stored?.groups ?? [])
    .map((g) => ({
      id: g.id,
      collapsed: Boolean(g.collapsed),
      columnIds: uniq((g.columnIds ?? []).filter((id) => known.has(id))),
    }))
    .filter((g) => g.columnIds.length >= 2);

  // Index just past `id`, or past the last member of the group holding it.
  const insertionAfter = (id: string) => {
    const group = groups.find((g) => g.columnIds.includes(id));
    const members = group ? group.columnIds : [id];
    return Math.max(...members.map((m) => order.indexOf(m))) + 1;
  };

  allIds.forEach((id, declaredIndex) => {
    if (order.includes(id)) return;
    let at = 0;
    for (let i = declaredIndex - 1; i >= 0; i--) {
      if (order.includes(allIds[i])) {
        at = insertionAfter(allIds[i]);
        break;
      }
    }
    order.splice(at, 0, id);
  });

  return normalize({ order, hidden, groups });
}

/**
 * Enforce invariants:
 * - each column belongs to at most one group;
 * - group members are contiguous in `order` (a group with non-contiguous
 *   members is dissolved);
 * - groups with fewer than 2 members are dropped;
 * - group order follows the position of its first member;
 * - each group's `columnIds` are stored in display order.
 */
export function normalize(state: ColumnLayoutState): ColumnLayoutState {
  const orderIndex = new Map(state.order.map((id, i) => [id, i]));
  const claimed = new Set<string>();
  const groups: ColumnGroup[] = [];

  const sortedGroups = [...state.groups].sort((a, b) => {
    const ai = Math.min(...a.columnIds.map((id) => orderIndex.get(id) ?? Infinity));
    const bi = Math.min(...b.columnIds.map((id) => orderIndex.get(id) ?? Infinity));
    return ai - bi;
  });

  for (const g of sortedGroups) {
    const members = g.columnIds.filter(
      (id) => orderIndex.has(id) && !claimed.has(id),
    );
    if (members.length < 2) continue;
    const indices = members.map((id) => orderIndex.get(id)!).sort((a, b) => a - b);
    const contiguous = indices.every(
      (idx, i) => i === 0 || idx === indices[i - 1] + 1,
    );
    if (!contiguous) continue; // dissolve non-contiguous groups
    members.forEach((id) => claimed.add(id));
    const ordered = [...members].sort(
      (a, b) => orderIndex.get(a)! - orderIndex.get(b)!,
    );
    groups.push({ id: g.id, collapsed: g.collapsed, columnIds: ordered });
  }

  return { order: [...state.order], hidden: uniq(state.hidden), groups };
}

export function groupOf(
  state: ColumnLayoutState,
  id: string,
): ColumnGroup | null {
  return state.groups.find((g) => g.columnIds.includes(id)) ?? null;
}

/**
 * Column ids that are visible, in display order. Excludes explicitly hidden
 * columns and every member of a collapsed group (a collapsed group's columns
 * are hidden; a "+" marker is shown at their position instead).
 */
export function visibleOrderedIds(state: ColumnLayoutState): string[] {
  const hidden = new Set(state.hidden);
  const collapsedMembers = new Set<string>();
  for (const g of state.groups) {
    if (g.collapsed) g.columnIds.forEach((id) => collapsedMembers.add(id));
  }
  return state.order.filter(
    (id) => !hidden.has(id) && !collapsedMembers.has(id),
  );
}

export function isHidden(state: ColumnLayoutState, id: string): boolean {
  return state.hidden.includes(id);
}

/**
 * Move column `fromId` so it lands immediately before `toId` (or to the end
 * when `toId` is null). Positions are computed against the full order
 * (including hidden columns) so drag targets stay stable.
 */
export function moveColumn(
  state: ColumnLayoutState,
  fromId: string,
  toId: string | null,
): ColumnLayoutState {
  if (fromId === toId || !state.order.includes(fromId)) return state;
  const order = state.order.filter((id) => id !== fromId);
  const insertAt = toId === null ? order.length : order.indexOf(toId);
  if (toId !== null && insertAt === -1) return state;
  order.splice(insertAt, 0, fromId);
  return normalize({ ...state, order });
}

/**
 * Move an entire group's columns as one contiguous block so it lands before
 * `toId` (or at the end when `toId` is null). Dropping onto one of the group's
 * own members is a no-op.
 */
export function moveGroup(
  state: ColumnLayoutState,
  groupId: string,
  toId: string | null,
): ColumnLayoutState {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return state;
  const members = new Set(group.columnIds);
  if (toId !== null && members.has(toId)) return state;
  const block = state.order.filter((id) => members.has(id));
  const without = state.order.filter((id) => !members.has(id));
  const insertAt = toId === null ? without.length : without.indexOf(toId);
  if (toId !== null && insertAt === -1) return state;
  const order = [
    ...without.slice(0, insertAt),
    ...block,
    ...without.slice(insertAt),
  ];
  return normalize({ ...state, order });
}

/** Reorder the *visible* column at index `from` to index `to` (visible-space). */
export function moveVisibleColumn(
  state: ColumnLayoutState,
  from: number,
  to: number,
): ColumnLayoutState {
  const visible = visibleOrderedIds(state);
  if (
    from < 0 ||
    to < 0 ||
    from >= visible.length ||
    to >= visible.length ||
    from === to
  ) {
    return state;
  }
  const fromId = visible[from];
  if (from < to) {
    const afterId = visible[to + 1] ?? null;
    return moveColumn(state, fromId, afterId);
  }
  return moveColumn(state, fromId, visible[to]);
}

export function setHidden(
  state: ColumnLayoutState,
  id: string,
  hidden: boolean,
): ColumnLayoutState {
  const has = state.hidden.includes(id);
  if (hidden === has) return state;
  const next = hidden
    ? [...state.hidden, id]
    : state.hidden.filter((h) => h !== id);
  return normalize({ ...state, hidden: next });
}

export function toggleHidden(
  state: ColumnLayoutState,
  id: string,
): ColumnLayoutState {
  return setHidden(state, id, !state.hidden.includes(id));
}

/** Show every column (clears the hidden set). */
export function showAll(state: ColumnLayoutState): ColumnLayoutState {
  if (state.hidden.length === 0) return state;
  return normalize({ ...state, hidden: [] });
}

let groupCounter = 0;
function nextGroupId(existing: ColumnGroup[]): string {
  const used = new Set(existing.map((g) => g.id));
  do {
    groupCounter += 1;
  } while (used.has(`group-${groupCounter}`));
  return `group-${groupCounter}`;
}

/**
 * Create a collapsible group from `columnIds`. Members are pulled contiguous
 * (in the relative order they already had) anchored at the earliest member's
 * position, and any existing group membership for those columns is removed
 * first. New groups start expanded. Requires ≥2 distinct, known columns;
 * otherwise returns state unchanged.
 */
export function createGroup(
  state: ColumnLayoutState,
  columnIds: string[],
  idFactory?: (existing: ColumnGroup[]) => string,
): ColumnLayoutState {
  const known = new Set(state.order);
  const members = uniq(columnIds.filter((id) => known.has(id)));
  if (members.length < 2) return state;

  // Detach these columns from any existing groups.
  const groups = state.groups
    .map((g) => ({
      ...g,
      columnIds: g.columnIds.filter((id) => !members.includes(id)),
    }))
    .filter((g) => g.columnIds.length >= 2);

  // Pull members contiguous: remove them, then reinsert as a block at the
  // earliest original index.
  const memberSet = new Set(members);
  const orderInMembers = state.order.filter((id) => memberSet.has(id));
  const earliestIdx = Math.min(...members.map((id) => state.order.indexOf(id)));
  const without = state.order.filter((id) => !memberSet.has(id));
  const before = state.order
    .slice(0, earliestIdx)
    .filter((id) => !memberSet.has(id)).length;
  const order = [
    ...without.slice(0, before),
    ...orderInMembers,
    ...without.slice(before),
  ];

  const id = (idFactory ?? nextGroupId)(state.groups);
  const group: ColumnGroup = { id, collapsed: false, columnIds: orderInMembers };
  return normalize({ ...state, order, groups: [...groups, group] });
}

/** Remove a group (columns stay where they are, just ungrouped). */
export function removeGroup(
  state: ColumnLayoutState,
  groupId: string,
): ColumnLayoutState {
  const groups = state.groups.filter((g) => g.id !== groupId);
  if (groups.length === state.groups.length) return state;
  return normalize({ ...state, groups });
}

export function setGroupCollapsed(
  state: ColumnLayoutState,
  groupId: string,
  collapsed: boolean,
): ColumnLayoutState {
  let changed = false;
  const groups = state.groups.map((g) => {
    if (g.id === groupId && g.collapsed !== collapsed) {
      changed = true;
      return { ...g, collapsed };
    }
    return g;
  });
  return changed ? normalize({ ...state, groups }) : state;
}

export function toggleGroupCollapsed(
  state: ColumnLayoutState,
  groupId: string,
): ColumnLayoutState {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return state;
  return setGroupCollapsed(state, groupId, !group.collapsed);
}
