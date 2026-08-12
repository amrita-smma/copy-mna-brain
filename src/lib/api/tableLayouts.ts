import { apiRequest } from '@/lib/api/client';
import type { ColumnLayoutState } from '@/lib/table/columnLayout';

/** Every saved table layout for the active workspace, keyed by table id. */
export function listTableLayouts(): Promise<Record<string, ColumnLayoutState>> {
  return apiRequest<Record<string, ColumnLayoutState>>('/api/table-layouts');
}

/** Save one table's layout for the whole workspace. */
export function saveTableLayout(
  tableId: string,
  layout: ColumnLayoutState,
): Promise<{ tableId: string; layout: ColumnLayoutState }> {
  return apiRequest('/api/table-layouts', {
    method: 'PUT',
    body: JSON.stringify({ tableId, layout }),
  });
}

/** Drop a table's saved layout so it falls back to the declared defaults. */
export function deleteTableLayout(tableId: string): Promise<{ tableId: string }> {
  return apiRequest(`/api/table-layouts?tableId=${encodeURIComponent(tableId)}`, {
    method: 'DELETE',
  });
}
