// The CRM "Last contact" filter presets (`LastContactFilter` in the CRM view):
// `today`, `yesterday`, `week`, `month`, `stale_30`, `custom`. Shared by the
// Firms list (`GET /api/crm`) and the person-level banker list
// (`BankerListService`: Brain Bots and the flagged Bankers view) so both read a
// preset the same way.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lower bound (ISO) for a "contacted since" preset: `today` / `yesterday` start
 * at the client's local midnight when `clientTodayIso` is given, `week` /
 * `month` are rolling 7 / 30 days, `custom` is the given `YYYY-MM-DD`.
 * `undefined` for no preset, `stale_30`, or an unparseable custom date.
 */
export function lastContactAfter(
  preset: string | null,
  custom: string | null,
  clientTodayIso: string | null,
  nowMs: number = Date.now(),
): string | undefined {
  if (!preset) return undefined;
  let startOfDay = new Date(nowMs);
  startOfDay.setHours(0, 0, 0, 0);
  if (clientTodayIso && !isNaN(Date.parse(clientTodayIso))) {
    startOfDay = new Date(clientTodayIso);
  }

  switch (preset) {
    case 'today':
      return startOfDay.toISOString();
    case 'yesterday':
      return new Date(startOfDay.getTime() - DAY_MS).toISOString();
    case 'week':
      return new Date(nowMs - 7 * DAY_MS).toISOString();
    case 'month':
      return new Date(nowMs - 30 * DAY_MS).toISOString();
    case 'custom': {
      if (!custom) return undefined;
      // Custom is YYYY-MM-DD — interpret as start-of-day.
      const customMs = Date.parse(custom);
      return !isNaN(customMs) ? new Date(customMs).toISOString() : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Upper bound (ISO) for the "More than 30 days" preset: last contact strictly
 * before it (or never contacted). `undefined` for every other preset.
 */
export function lastContactBefore(
  preset: string | null,
  nowMs: number = Date.now(),
): string | undefined {
  if (preset !== 'stale_30') return undefined;
  return new Date(nowMs - 30 * DAY_MS).toISOString();
}
