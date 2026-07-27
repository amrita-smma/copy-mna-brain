import { VAULT_CUSTODIAN_EMAILS } from '@/lib/services/googleVaultService';

export const VAULT_BACKFILL_FLOOR_DAILY_DEFAULT = '2026-01-01';

export interface YearMonthDay {
  year: number;
  month: number;
  day: number;
}

export function parseFloorDay(raw: string): YearMonthDay {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`daily backfill floor must be YYYY-MM-DD, got "${raw}"`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2020 ||
    year > 2100 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`daily backfill floor out of range or invalid: ${raw}`);
  }

  return { year, month, day };
}

export function currentDayUTC(now: Date = new Date()): YearMonthDay {
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  };
}

export function previousDay(value: YearMonthDay): YearMonthDay {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  date.setUTCDate(date.getUTCDate() - 1);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function ymdLessThanOrEqual(a: YearMonthDay, b: YearMonthDay): boolean {
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day <= b.day;
}

export function daysBetween(floor: YearMonthDay, ceiling: YearMonthDay): YearMonthDay[] {
  const days: YearMonthDay[] = [];
  const current = new Date(Date.UTC(floor.year, floor.month - 1, floor.day));
  const end = new Date(Date.UTC(ceiling.year, ceiling.month - 1, ceiling.day));

  while (current.getTime() <= end.getTime()) {
    days.push({
      year: current.getUTCFullYear(),
      month: current.getUTCMonth() + 1,
      day: current.getUTCDate(),
    });
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return days;
}

export function dayWindow(
  year: number,
  month: number,
  day: number,
): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, day)),
    end: new Date(Date.UTC(year, month - 1, day + 1)),
  };
}

/**
 * Vault names MBOX entries with the custodian email in the path. Match the
 * longest configured address first so one address cannot shadow another.
 */
export function inferCustodianFromEntry(
  entryName: string,
  custodians: string[] = VAULT_CUSTODIAN_EMAILS,
): string {
  const lowerEntryName = entryName.toLowerCase();
  const longestFirst = [...custodians].sort((a, b) => b.length - a.length);
  return (
    longestFirst.find((custodian) =>
      lowerEntryName.includes(custodian.toLowerCase()),
    ) ?? 'unknown'
  );
}
