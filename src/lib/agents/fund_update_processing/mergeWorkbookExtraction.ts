import {
  formatSourceRowKey,
  type AmbiguousRowItem,
  type ExcludedRowItem,
  type ProposedEntity,
  type ProposedEvent,
  type ProposedValuation,
  type RowAccounting,
  type SourceRowRef,
  type UnaccountedRowItem,
} from '@/lib/fund_updates/types';
import type { ChunkExtractionResult } from './schemas';

export interface MergedExtraction {
  entities: ProposedEntity[];
  events: ProposedEvent[];
  valuations: ProposedValuation[];
  rowAccounting: RowAccounting;
  warnings: string[];
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Merges chunk extraction results across the entire workbook.
 * Uses source-qualified composite keys ({ sheet, tableId, row }) to avoid cross-sheet row collisions.
 * Checks for disjointness between parsed, excluded, and ambiguous sets.
 * Accurately derives unaccounted rows from the planned source row universe.
 */
export function mergeWorkbookExtraction(
  chunkResults: ChunkExtractionResult[],
  totalDataRowsOrPlanned: number | SourceRowRef[],
  plannedRowsParam?: SourceRowRef[],
): MergedExtraction {
  const plannedRows: SourceRowRef[] = Array.isArray(totalDataRowsOrPlanned)
    ? totalDataRowsOrPlanned
    : plannedRowsParam || [];
  const totalWorkbookDataRows: number = Array.isArray(totalDataRowsOrPlanned)
    ? totalDataRowsOrPlanned.length
    : totalDataRowsOrPlanned;

  const entityMap = new Map<string, ProposedEntity>();
  const oldIdToCanonicalName = new Map<string, string>();

  const allEvents: ProposedEvent[] = [];
  const allValuations: ProposedValuation[] = [];
  const allWarnings: string[] = [];

  const extractedEventRowKeys = new Set<string>();

  interface RawRowRef {
    sheet: string;
    tableId: string;
    row: number;
    key: string;
  }

  interface RawExcludedRowRef extends RawRowRef {
    reason: string;
  }

  interface RawAmbiguousRowRef extends RawRowRef {
    reason: string;
  }

  const rawParsedRowMap = new Map<string, RawRowRef>();
  const rawExcludedRowsByKey = new Map<string, RawExcludedRowRef[]>();
  const rawAmbiguousRowsByKey = new Map<string, RawAmbiguousRowRef[]>();

  let entityCounter = 0;

  for (const chunk of chunkResults) {
    if (chunk.warnings) {
      allWarnings.push(...chunk.warnings);
    }

    const chunkSheet = chunk.sheetName || '';
    const chunkTableId = chunk.tableId || '';

    // 1. Process entities from this chunk
    for (const ent of chunk.entities || []) {
      const origName = ent.originalName?.trim();
      if (!origName) continue;

      const normKey = normalizeNameKey(origName);
      let canonical = entityMap.get(normKey);

      if (!canonical) {
        entityCounter++;
        const cleanLocs = (ent.sourceLocations || []).map((loc) => ({
          sheet: loc.sheet || chunkSheet,
          row: loc.row ?? 0,
          columns: loc.columns,
          cellAddress: loc.cellAddress,
        }));
        canonical = {
          proposalId: `ent_${entityCounter}`,
          entityType: ent.entityType || 'unknown',
          originalName: origName,
          englishName: ent.englishName || null,
          aliases: ent.aliases || [],
          existingRecordId: ent.existingRecordId || null,
          matchConfidence: ent.matchConfidence || null,
          sourceLocations: cleanLocs,
          warnings: ent.warnings || [],
        };
        entityMap.set(normKey, canonical);
      } else {
        // Merge aliases
        if (ent.englishName && !canonical.englishName) {
          canonical.englishName = ent.englishName;
        }
        for (const alias of ent.aliases || []) {
          if (!canonical.aliases.includes(alias) && alias !== canonical.originalName) {
            canonical.aliases.push(alias);
          }
        }
        // Merge source locations
        for (const loc of ent.sourceLocations || []) {
          canonical.sourceLocations.push({
            sheet: loc.sheet || chunkSheet,
            row: loc.row ?? 0,
            columns: loc.columns,
            cellAddress: loc.cellAddress,
          });
        }
      }

      if (ent.proposalId) {
        oldIdToCanonicalName.set(ent.proposalId, canonical.originalName);
      }
    }

    // 2. Process events
    for (const evt of chunk.events || []) {
      const evtSheet = evt.sourceLocation?.sheet || chunkSheet;
      if (!evt.sourceLocation) {
        evt.sourceLocation = { sheet: evtSheet, row: 0 };
      } else if (!evt.sourceLocation.sheet) {
        evt.sourceLocation.sheet = evtSheet;
      }
      allEvents.push(evt as ProposedEvent);
      if (evt.sourceLocation.row != null && evt.sourceLocation.row > 0) {
        extractedEventRowKeys.add(formatSourceRowKey(chunkSheet, evt.sourceLocation.row, chunkTableId));
        extractedEventRowKeys.add(formatSourceRowKey(evt.sourceLocation.sheet, evt.sourceLocation.row, chunkTableId));
      }
    }

    // 3. Process valuations
    for (const val of chunk.valuations || []) {
      const valSheet = val.sourceLocation?.sheet || chunkSheet;
      if (!val.sourceLocation) {
        val.sourceLocation = { sheet: valSheet, row: 0 };
      } else if (!val.sourceLocation.sheet) {
        val.sourceLocation.sheet = valSheet;
      }
      allValuations.push(val as ProposedValuation);
      if (val.sourceLocation.row != null && val.sourceLocation.row > 0) {
        extractedEventRowKeys.add(formatSourceRowKey(chunkSheet, val.sourceLocation.row, chunkTableId));
        extractedEventRowKeys.add(formatSourceRowKey(val.sourceLocation.sheet, val.sourceLocation.row, chunkTableId));
      }
    }

    // 4. Collect raw accounting rows from this chunk
    for (const r of chunk.parsedRows || []) {
      const key = formatSourceRowKey(chunkSheet, r, chunkTableId);
      if (!rawParsedRowMap.has(key)) {
        rawParsedRowMap.set(key, {
          sheet: chunkSheet,
          tableId: chunkTableId,
          row: r,
          key,
        });
      }
    }

    for (const e of chunk.excludedRows || []) {
      if (e.row == null) continue;
      const sheet = e.sheet || chunkSheet;
      const key = formatSourceRowKey(sheet, e.row, chunkTableId);
      const list = rawExcludedRowsByKey.get(key) || [];
      list.push({
        sheet,
        tableId: chunkTableId,
        row: e.row,
        key,
        reason: e.reason || '',
      });
      rawExcludedRowsByKey.set(key, list);
    }

    for (const a of chunk.ambiguousRows || []) {
      if (a.row == null) continue;
      const sheet = a.sheet || chunkSheet;
      const key = formatSourceRowKey(sheet, a.row, chunkTableId);
      const list = rawAmbiguousRowsByKey.get(key) || [];
      list.push({
        sheet,
        tableId: chunkTableId,
        row: a.row,
        key,
        reason: a.reason || '',
      });
      rawAmbiguousRowsByKey.set(key, list);
    }
  }

  // 5. Resolve categories across all chunks deterministically
  const parsedRowMap = new Map<string, SourceRowRef>();
  const excludedRowMap = new Map<string, ExcludedRowItem>();
  const ambiguousRowMap = new Map<string, AmbiguousRowItem>();
  const seenCategoryByRowKey = new Map<string, 'parsed' | 'excluded' | 'ambiguous'>();

  const allRowKeys = new Set<string>([
    ...rawParsedRowMap.keys(),
    ...rawExcludedRowsByKey.keys(),
    ...rawAmbiguousRowsByKey.keys(),
  ]);

  for (const key of allRowKeys) {
    const parsedRef = rawParsedRowMap.get(key);
    const hasParsedClaim = Boolean(parsedRef) || extractedEventRowKeys.has(key);
    const hasEvent = extractedEventRowKeys.has(key);
    const excludedList = rawExcludedRowsByKey.get(key) || [];
    const ambiguousList = rawAmbiguousRowsByKey.get(key) || [];

    const sheet = parsedRef?.sheet || excludedList[0]?.sheet || ambiguousList[0]?.sheet || '';
    const tableId = parsedRef?.tableId || excludedList[0]?.tableId || ambiguousList[0]?.tableId || '';
    const row = parsedRef?.row ?? excludedList[0]?.row ?? ambiguousList[0]?.row ?? 0;

    if (hasEvent) {
      // Deterministic category precedence: parsed wins over ambiguous/excluded when an event was extracted.
      // Retain ambiguity/exclusion reasons as warnings/provenance signals without duplicating accounting buckets.
      parsedRowMap.set(key, {
        sheet,
        tableId,
        row,
        rowKey: key,
      });
      seenCategoryByRowKey.set(key, 'parsed');

      for (const a of ambiguousList) {
        allWarnings.push(
          `Row ${a.row} on sheet "${a.sheet}" (table "${a.tableId}") was categorized as both parsed and ambiguous (reason: "${a.reason}"); parsed event takes precedence.`,
        );
      }
      for (const e of excludedList) {
        allWarnings.push(
          `Row ${e.row} on sheet "${e.sheet}" (table "${e.tableId}") was categorized as both parsed and excluded (reason: "${e.reason}"); parsed event takes precedence.`,
        );
      }
    } else {
      // No event extracted for this source row.
      const hasExcludedClaim = excludedList.length > 0;
      const hasAmbiguousClaim = ambiguousList.length > 0;

      const claimCount = (hasParsedClaim ? 1 : 0) + (hasExcludedClaim ? 1 : 0) + (hasAmbiguousClaim ? 1 : 0);

      if (claimCount === 1) {
        if (hasParsedClaim && parsedRef) {
          parsedRowMap.set(key, {
            sheet,
            tableId,
            row,
            rowKey: key,
          });
          seenCategoryByRowKey.set(key, 'parsed');
        } else if (hasExcludedClaim) {
          const reason = excludedList.map((e) => e.reason).filter(Boolean).join('; ') || '';
          excludedRowMap.set(key, {
            sheet,
            tableId,
            row,
            reason,
          });
          seenCategoryByRowKey.set(key, 'excluded');
        } else if (hasAmbiguousClaim) {
          const reason = ambiguousList.map((a) => a.reason).filter(Boolean).join('; ') || '';
          ambiguousRowMap.set(key, {
            sheet,
            tableId,
            row,
            reason,
          });
          seenCategoryByRowKey.set(key, 'ambiguous');
        }
      } else if (claimCount > 1) {
        // Contradictory classifications with no parsed event.
        // Place in conflicting buckets to preserve downstream hard failure.
        if (hasParsedClaim && parsedRef) {
          parsedRowMap.set(key, {
            sheet,
            tableId,
            row,
            rowKey: key,
          });
          seenCategoryByRowKey.set(key, 'parsed');
        }
        if (hasExcludedClaim) {
          const reason = excludedList.map((e) => e.reason).filter(Boolean).join('; ') || '';
          excludedRowMap.set(key, {
            sheet,
            tableId,
            row,
            reason,
          });
          seenCategoryByRowKey.set(key, 'excluded');
        }
        if (hasAmbiguousClaim) {
          const reason = ambiguousList.map((a) => a.reason).filter(Boolean).join('; ') || '';
          ambiguousRowMap.set(key, {
            sheet,
            tableId,
            row,
            reason,
          });
          seenCategoryByRowKey.set(key, 'ambiguous');
        }

        if (hasParsedClaim && hasAmbiguousClaim) {
          const reason = ambiguousList.map((a) => a.reason).filter(Boolean).join('; ');
          allWarnings.push(
            `Row ${row} on sheet "${sheet}" (table "${tableId}") was categorized as both parsed (with no extracted event) and ambiguous (reason: "${reason}").`,
          );
        }
        if (hasParsedClaim && hasExcludedClaim) {
          const reason = excludedList.map((e) => e.reason).filter(Boolean).join('; ');
          allWarnings.push(
            `Row ${row} on sheet "${sheet}" (table "${tableId}") was categorized as both parsed (with no extracted event) and excluded (reason: "${reason}").`,
          );
        }
        if (hasExcludedClaim && hasAmbiguousClaim) {
          const exReason = excludedList.map((e) => e.reason).filter(Boolean).join('; ');
          const ambReason = ambiguousList.map((a) => a.reason).filter(Boolean).join('; ');
          allWarnings.push(
            `Row ${row} on sheet "${sheet}" (table "${tableId}") was categorized as both excluded (reason: "${exReason}") and ambiguous (reason: "${ambReason}").`,
          );
        }
      }
    }
  }

  // Check unaccounted rows against planned universe
  const unaccountedRowItems: UnaccountedRowItem[] = [];
  const unaccountedRows: number[] = [];

  if (plannedRows.length > 0) {
    for (const pl of plannedRows) {
      const key = pl.rowKey || formatSourceRowKey(pl.sheet, pl.row, pl.tableId);
      if (!seenCategoryByRowKey.has(key)) {
        unaccountedRowItems.push({
          sheet: pl.sheet,
          tableId: pl.tableId,
          row: pl.row,
          reason: `Row ${pl.row} on sheet "${pl.sheet}" was in extraction plan but omitted by extractor`,
        });
        unaccountedRows.push(pl.row);
      }
    }
  } else if (totalWorkbookDataRows > 0) {
    // If no explicit plannedRows array provided, check total count vs accounted count
    const accountedCount = seenCategoryByRowKey.size;
    if (accountedCount < totalWorkbookDataRows) {
      const missingCount = totalWorkbookDataRows - accountedCount;
      for (let i = 0; i < missingCount; i++) {
        unaccountedRows.push(-1);
      }
    }
  }

  const parsedRowItems = Array.from(parsedRowMap.values()).sort(
    (a, b) => (a.sheet === b.sheet ? a.row - b.row : a.sheet.localeCompare(b.sheet)),
  );
  const excludedRowItems = Array.from(excludedRowMap.values()).sort(
    (a, b) => ((a.sheet || '') === (b.sheet || '') ? a.row - b.row : (a.sheet || '').localeCompare(b.sheet || '')),
  );
  const ambiguousRowItems = Array.from(ambiguousRowMap.values()).sort(
    (a, b) => ((a.sheet || '') === (b.sheet || '') ? a.row - b.row : (a.sheet || '').localeCompare(b.sheet || '')),
  );

  const parsedRowNumbers = parsedRowItems.map((r) => r.row);
  const effectiveTotalRows = Math.max(
    totalWorkbookDataRows,
    plannedRows.length,
    seenCategoryByRowKey.size,
  );

  const coveragePct = effectiveTotalRows > 0
    ? Math.round((parsedRowItems.length / effectiveTotalRows) * 1000) / 10
    : 100;

  const entities = Array.from(entityMap.values());

  // Assign stable proposalIds for events
  let eventCounter = 0;
  for (const evt of allEvents) {
    eventCounter++;
    evt.proposalId = `evt_${eventCounter}`;
  }

  let valCounter = 0;
  for (const val of allValuations) {
    valCounter++;
    val.proposalId = `val_${valCounter}`;
  }

  return {
    entities,
    events: allEvents,
    valuations: allValuations,
    rowAccounting: {
      totalDataRows: effectiveTotalRows,
      plannedRows: plannedRows.length > 0 ? plannedRows : undefined,
      parsedRows: parsedRowNumbers,
      parsedRowItems,
      excludedRows: excludedRowItems,
      ambiguousRows: ambiguousRowItems,
      coveragePct,
      unaccountedRows,
      unaccountedRowItems: unaccountedRowItems.length > 0 ? unaccountedRowItems : undefined,
    },
    warnings: allWarnings,
  };
}
