import type {
  WorkspaceTableLayoutRepository,
} from '@/lib/repositories/workspaceTableLayoutRepository';
import type { ColumnLayoutState } from '@/lib/table/columnLayout';

/** A table layout as served to the client. */
export interface TableLayout {
  tableId: string;
  layout: ColumnLayoutState;
  updatedAt: string | null;
}

/** Raised when a caller sends a `layout` blob that isn't a ColumnLayoutState. */
export class InvalidTableLayoutError extends Error {
  constructor(message = 'layout must be a { order, hidden, groups } object') {
    super(message);
    this.name = 'InvalidTableLayoutError';
  }
}

/** Raised when `tableId` is missing, blank, or not a plausible table id. */
export class InvalidTableIdError extends Error {
  constructor(message = 'tableId is required') {
    super(message);
    this.name = 'InvalidTableIdError';
  }
}

/**
 * Table ids are compile-time constants at the call sites (`master-data`,
 * `pipeline-inbound:active`, ...), so they are constrained by shape rather than
 * by an allowlist — the hook stays reusable for new tables, while a client can't
 * fill the table with arbitrary junk rows.
 */
const TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]*$/i;
const TABLE_ID_MAX_LENGTH = 64;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/**
 * Coerce an untrusted blob into a ColumnLayoutState, or return null when it
 * can't be one. Unknown extra keys are dropped rather than stored, so a stale
 * or hand-crafted client can't grow the persisted shape. Reconciliation against
 * the table's *live* column ids stays client-side (`initLayout`), since only the
 * client knows which columns a table currently declares.
 */
export function parseColumnLayoutState(value: unknown): ColumnLayoutState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isStringArray(raw.order) || !isStringArray(raw.hidden)) return null;
  if (!Array.isArray(raw.groups)) return null;

  const groups = [];
  for (const entry of raw.groups) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const group = entry as Record<string, unknown>;
    if (typeof group.id !== 'string') return null;
    if (!isStringArray(group.columnIds)) return null;
    if (typeof group.collapsed !== 'boolean') return null;
    groups.push({ id: group.id, columnIds: group.columnIds, collapsed: group.collapsed });
  }

  return { order: raw.order, hidden: raw.hidden, groups };
}

/**
 * Workspace-wide column layouts for the managed data tables. Layouts are shared
 * by every member of a workspace — arranging, hiding, or grouping columns in one
 * table changes it for the whole workspace, not just the user who did it.
 */
export class TableLayoutService {
  constructor(private readonly repo: WorkspaceTableLayoutRepository) {}

  /** Every table's layout for the active workspace, keyed by table id. */
  async listLayouts(): Promise<Record<string, ColumnLayoutState>> {
    const rows = await this.repo.findAll();
    const map: Record<string, ColumnLayoutState> = {};
    for (const row of rows) {
      const parsed = parseColumnLayoutState(row.layout);
      // Silently skip rows written by an older/incompatible shape rather than
      // failing the whole hydration request for every table.
      if (parsed) map[row.tableId] = parsed;
    }
    return map;
  }

  /** One table's layout, or null when the workspace has never saved it. */
  async getLayout(tableId: string): Promise<TableLayout | null> {
    const id = this.requireTableId(tableId);
    const row = await this.repo.findByTableId(id);
    if (!row) return null;
    const parsed = parseColumnLayoutState(row.layout);
    if (!parsed) return null;
    return { tableId: row.tableId, layout: parsed, updatedAt: row.updatedAt };
  }

  /** Save one table's layout for the whole workspace. */
  async saveLayout(
    tableId: string,
    layout: unknown,
    updatedBy?: string | null,
  ): Promise<TableLayout> {
    const id = this.requireTableId(tableId);
    const parsed = parseColumnLayoutState(layout);
    if (!parsed) throw new InvalidTableLayoutError();
    const updatedAt = await this.repo.upsert(id, parsed, updatedBy ?? null);
    return { tableId: id, layout: parsed, updatedAt };
  }

  /** Drop a table's saved layout so it falls back to the declared defaults. */
  async resetLayout(tableId: string): Promise<void> {
    await this.repo.delete(this.requireTableId(tableId));
  }

  private requireTableId(tableId: string): string {
    if (typeof tableId !== 'string' || !tableId.trim()) {
      throw new InvalidTableIdError();
    }
    const id = tableId.trim();
    if (id.length > TABLE_ID_MAX_LENGTH || !TABLE_ID_PATTERN.test(id)) {
      throw new InvalidTableIdError('tableId is not a valid table identifier');
    }
    return id;
  }
}
