export const DEFAULT_INSIGHT_REFRESH_PROMPT =
  'Refresh every section with the latest available data. Keep the existing structure, sections and styling unless the new data requires a change.';

/**
 * The fixed paragraph every refresh run ends with (MB-551): the insight's
 * documented Sources are re-fetched first, and only a source that is gone or
 * doesn't cover what is needed sends the run searching further.
 */
export const INSIGHT_REFRESH_SOURCES_PARAGRAPH =
  'Sources: re-fetch every figure from the sources documented in the insight\'s Sources section (<section data-section="sources">) first, and update each entry\'s data-retrieved date to the day you retrieved it. Search further only when a documented source is gone or does not cover what is needed, and add a new Sources entry for every new source you use. Keep every figure referenced to a Sources entry ([S1]-style data-source-ref). Where a figure can no longer be obtained, mark its cell unavailable (data-evidence="unavailable") with the reason instead of keeping the old value or estimating one. If the insight has no Sources section yet, add one with replace_insight_document (edit_insight_section can only replace a section that already exists) before or in the same write as the first figure that cites it, and reference every figure you write.';

/**
 * Output, exactly:
 *   line 1: `This is a scheduled refresh of the insight "<insightName>" (insight_id: <insightId>).`
 *           — when insightName is null: `This is a scheduled refresh of insight <insightId>.`
 *   line 2: blank
 *   line 3: userPrompt.trim(), or DEFAULT_INSIGHT_REFRESH_PROMPT when that is empty.
 *   line 4: blank
 *   line 5: INSIGHT_REFRESH_SOURCES_PARAGRAPH (always, whatever the user prompt says).
 */
export function buildInsightRefreshPrompt(args: {
  insightId: string;
  insightName: string | null;
  userPrompt: string;
}): string {
  const header =
    args.insightName !== null
      ? `This is a scheduled refresh of the insight "${args.insightName}" (insight_id: ${args.insightId}).`
      : `This is a scheduled refresh of insight ${args.insightId}.`;

  const trimmed = args.userPrompt.trim();
  const body = trimmed.length > 0 ? trimmed : DEFAULT_INSIGHT_REFRESH_PROMPT;

  return `${header}\n\n${body}\n\n${INSIGHT_REFRESH_SOURCES_PARAGRAPH}`;
}
