import { describe, it, expect } from "vitest";
import {
  initLayout,
  normalize,
  visibleOrderedIds,
  moveColumn,
  moveVisibleColumn,
  setHidden,
  toggleHidden,
  showAll,
  createGroup,
  moveGroup,
  removeGroup,
  setGroupCollapsed,
  toggleGroupCollapsed,
  groupOf,
  type ColumnLayoutState,
} from "./columnLayout";

const ALL = ["a", "b", "c", "d", "e"];

const base = (over: Partial<ColumnLayoutState> = {}): ColumnLayoutState => ({
  order: [...ALL],
  hidden: [],
  groups: [],
  ...over,
});

// deterministic group id factory so assertions are stable
const idFactory = (existing: { id: string }[]) => `g${existing.length + 1}`;

describe("initLayout", () => {
  it("returns declared order when there is no stored layout", () => {
    expect(initLayout(ALL).order).toEqual(ALL);
  });

  it("appends newly-added columns after the stored order", () => {
    const state = initLayout(ALL, { order: ["c", "a"] });
    expect(state.order).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("drops stored ids that no longer exist from order, hidden and groups", () => {
    const state = initLayout(["a", "b"], {
      order: ["b", "a", "gone"],
      hidden: ["gone", "a"],
      groups: [{ id: "g1", collapsed: false, columnIds: ["gone", "a", "b"] }],
    });
    expect(state.order).toEqual(["b", "a"]);
    expect(state.hidden).toEqual(["a"]);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].columnIds).toEqual(["b", "a"]);
  });

  it("preserves the collapsed flag from storage", () => {
    const state = initLayout(ALL, {
      groups: [{ id: "g1", collapsed: true, columnIds: ["a", "b"] }],
    });
    expect(state.groups[0].collapsed).toBe(true);
  });

  it("tolerates null stored state", () => {
    expect(initLayout(ALL, null).order).toEqual(ALL);
  });
});

describe("visibleOrderedIds", () => {
  it("omits hidden columns but preserves order", () => {
    expect(visibleOrderedIds(base({ hidden: ["b", "d"] }))).toEqual([
      "a",
      "c",
      "e",
    ]);
  });

  it("hides every member of a collapsed group (no column space)", () => {
    const s = createGroup(base(), ["b", "c", "d"], idFactory);
    const collapsed = setGroupCollapsed(s, "g1", true);
    // the whole group collapses away; only a and e remain
    expect(visibleOrderedIds(collapsed)).toEqual(["a", "e"]);
  });

  it("shows every member of an expanded group", () => {
    const s = createGroup(base(), ["b", "c", "d"], idFactory);
    expect(visibleOrderedIds(s)).toEqual(ALL);
  });
});

describe("moveColumn", () => {
  it("moves a column before the target", () => {
    expect(moveColumn(base(), "d", "b").order).toEqual([
      "a",
      "d",
      "b",
      "c",
      "e",
    ]);
  });

  it("moves a column to the end when target is null", () => {
    expect(moveColumn(base(), "b", null).order).toEqual([
      "a",
      "c",
      "d",
      "e",
      "b",
    ]);
  });

  it("is a no-op when from equals to", () => {
    const s = base();
    expect(moveColumn(s, "b", "b")).toBe(s);
  });
});

describe("moveVisibleColumn", () => {
  it("reorders within visible space, skipping hidden columns", () => {
    const s = base({ hidden: ["b", "d"] });
    const next = moveVisibleColumn(s, 0, 2);
    expect(visibleOrderedIds(next)).toEqual(["c", "e", "a"]);
  });

  it("moves left correctly", () => {
    const next = moveVisibleColumn(base(), 3, 1);
    expect(visibleOrderedIds(next)).toEqual(["a", "d", "b", "c", "e"]);
  });
});

describe("hiding", () => {
  it("setHidden hides and shows", () => {
    const hidden = setHidden(base(), "c", true);
    expect(hidden.hidden).toContain("c");
    expect(setHidden(hidden, "c", false).hidden).not.toContain("c");
  });

  it("toggleHidden flips state", () => {
    expect(toggleHidden(base(), "a").hidden).toEqual(["a"]);
  });

  it("showAll clears the hidden set", () => {
    expect(showAll(base({ hidden: ["a", "b"] })).hidden).toEqual([]);
  });
});

describe("createGroup", () => {
  it("groups contiguous columns, starting expanded", () => {
    const s = createGroup(base(), ["b", "c"], idFactory);
    expect(s.groups).toEqual([
      { id: "g1", collapsed: false, columnIds: ["b", "c"] },
    ]);
    expect(s.order).toEqual(ALL);
  });

  it("pulls non-contiguous columns adjacent, anchored at the earliest", () => {
    const s = createGroup(base(), ["a", "c", "e"], idFactory);
    expect(s.order).toEqual(["a", "c", "e", "b", "d"]);
    expect(s.groups[0].columnIds).toEqual(["a", "c", "e"]);
  });

  it("requires at least two known columns", () => {
    const s = base();
    expect(createGroup(s, ["a"], idFactory)).toBe(s);
    expect(createGroup(s, ["a", "zzz"], idFactory)).toBe(s);
  });

  it("detaches columns from a previous group before regrouping", () => {
    let s = createGroup(base(), ["a", "b"], idFactory);
    s = createGroup(s, ["b", "c"], idFactory);
    expect(s.groups).toHaveLength(1);
    expect(groupOf(s, "a")).toBeNull();
    expect(groupOf(s, "b")?.columnIds).toEqual(["b", "c"]);
  });
});

describe("collapse", () => {
  it("setGroupCollapsed toggles and is a no-op when unchanged", () => {
    const s = createGroup(base(), ["b", "c"], idFactory);
    const collapsed = setGroupCollapsed(s, "g1", true);
    expect(collapsed.groups[0].collapsed).toBe(true);
    expect(setGroupCollapsed(collapsed, "g1", true)).toBe(collapsed);
  });

  it("toggleGroupCollapsed flips the flag", () => {
    const s = createGroup(base(), ["b", "c"], idFactory);
    expect(toggleGroupCollapsed(s, "g1").groups[0].collapsed).toBe(true);
  });

  it("ignores an unknown group id", () => {
    const s = createGroup(base(), ["b", "c"], idFactory);
    expect(toggleGroupCollapsed(s, "nope")).toBe(s);
  });
});

describe("moveGroup", () => {
  it("moves the whole group block before the target", () => {
    // group c,d then move it before a
    const grouped = createGroup(base(), ["c", "d"], idFactory);
    const moved = moveGroup(grouped, "g1", "a");
    expect(moved.order).toEqual(["c", "d", "a", "b", "e"]);
    expect(moved.groups[0].columnIds).toEqual(["c", "d"]);
  });

  it("moves the group to the end when target is null", () => {
    const grouped = createGroup(base(), ["b", "c"], idFactory);
    const moved = moveGroup(grouped, "g1", null);
    expect(moved.order).toEqual(["a", "d", "e", "b", "c"]);
  });

  it("is a no-op when dropped on one of its own members", () => {
    const grouped = createGroup(base(), ["b", "c"], idFactory);
    expect(moveGroup(grouped, "g1", "b")).toBe(grouped);
  });

  it("keeps the group intact after moving", () => {
    const grouped = createGroup(base(), ["b", "c"], idFactory);
    const moved = moveGroup(grouped, "g1", "e");
    expect(moved.groups).toHaveLength(1);
    expect(groupOf(moved, "b")?.id).toBe(groupOf(moved, "c")?.id);
  });
});

describe("removeGroup", () => {
  it("ungroups columns without moving them", () => {
    const grouped = createGroup(base(), ["b", "c"], idFactory);
    const s = removeGroup(grouped, "g1");
    expect(s.groups).toHaveLength(0);
    expect(s.order).toEqual(grouped.order);
  });
});

describe("normalize", () => {
  it("dissolves a group whose members are no longer contiguous", () => {
    const grouped = createGroup(base(), ["a", "b"], idFactory);
    const moved = moveColumn(grouped, "c", "b");
    expect(moved.order).toEqual(["a", "c", "b", "d", "e"]);
    expect(moved.groups).toHaveLength(0);
  });

  it("keeps a collapsed group when a member is explicitly hidden", () => {
    let s = createGroup(base(), ["a", "b", "c"], idFactory);
    s = setGroupCollapsed(s, "g1", true);
    s = setHidden(s, "c", true);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].collapsed).toBe(true);
  });
});
