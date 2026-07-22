import type { ParsedAsset, StartechParseResult } from './parsers/startech_quarterly';

/**
 * Structured notes shape for `file_type = fund_updates`.
 * Propose-only: reviewers will approve per-asset applies later.
 */
export interface FundUpdateStructuredResult {
  file_type: 'fund_updates';
  /** Which parser produced the proposal (e.g. deterministic template_id or llm_fallback). */
  parser: string;
  summary: string;
  key_points: string[];
  action_items: string[];
  tags: string[];
  companies_detected: string[];
  company_notes: Array<{ company_name: string; note: string }>;
  file_date: string | null;
  suggested_track_ids: string[];
  matched_companies: unknown[];
  /** Deterministic / LLM proposal payload for HITL. Absent if no assets were found. */
  fund_update_proposal?: {
    template_id: string;
    stats: StartechParseResult['stats'];
    assets: ParsedAsset[];
  };
}
