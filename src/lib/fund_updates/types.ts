import type { ParsedAsset, StartechParseResult } from './parsers/startech_quarterly';

/**
 * Structured notes shape for `file_type = fund_updates`.
 * Propose-only: reviewers will approve per-asset applies later (mockup pending).
 *
 * TODO: `parser: 'pending_llm'` path + auto file-type classification are deferred;
 * MVP only fills `fund_update_proposal` via fingerprint-matched Excel parsers.
 */
export interface FundUpdateStructuredResult {
  file_type: 'fund_updates';
  /** Which parser produced the proposal (`pending_llm` until LLM extraction exists). */
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
  /** Deterministic / LLM proposal payload for HITL. Absent for placeholder results. */
  fund_update_proposal?: {
    template_id: string;
    stats: StartechParseResult['stats'];
    assets: ParsedAsset[];
  };
}
