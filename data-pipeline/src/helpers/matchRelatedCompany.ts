// Matches a raw LLM-extracted company name against the companies pipeline table.
// Returns the matching company_id (uuid) or null if no confident match.

import type { CompanyRepository } from '@/lib/repositories';

// Canonical normalizer lives in the app so the CRM service can share it; we
// re-export here so existing callers (crmIngest) keep importing it from the helper.
export { normalizeCompanyName } from '@/lib/crm/normalizeCompanyName';
import { normalizeCompanyName } from '@/lib/crm/normalizeCompanyName';

export type CompanyRow = { id: string; target: string | null; project_name: string | null };

export async function loadCompanyIndex(companyRepo: CompanyRepository): Promise<CompanyRow[]> {
  return companyRepo.findAllIdAndTarget();
}

export async function matchRelatedCompany(
  rawName: string,
  companyRepo: CompanyRepository,
  preloaded?: CompanyRow[],
): Promise<string | null> {
  if (!rawName.trim()) return null;

  const normalized = normalizeCompanyName(rawName);
  if (!normalized) return null;

  const all = preloaded ?? await companyRepo.findAllIdAndTarget();

  // 1. Exact normalized match against target or project_name.
  for (const row of all) {
    const normTarget = row.target ? normalizeCompanyName(row.target) : null;
    const normProject = row.project_name ? normalizeCompanyName(row.project_name) : null;
    if (normTarget === normalized || normProject === normalized) return row.id;
  }

  // 2. Fuzzy fallback: ILIKE-style substring (case-insensitive).
  const fuzzy = await companyRepo.findByNameFuzzy(rawName);
  if (fuzzy) return fuzzy.id;

  return null;
}
