import levenshtein from 'fast-levenshtein';
import { createDb } from '@/lib/server/db';
import { CompanyRepository } from '@/lib/repositories';
import { getActiveWorkspaceId } from '@/lib/workspace';

interface MatchResult {
  id: string;
  name: string;
  type: 'company';
  similarity: number;
}

/** Minimal company shape the Levenshtein matcher compares against. */
export interface CompanyCandidate {
  id: string;
  target: string | null;
  project_name: string | null;
}

/**
 * Pure Levenshtein matcher: given a search name and an in-memory list of
 * candidate companies (each with a `target` and/or `project_name`), return the
 * closest match within `threshold` relative distance, or null. No I/O, so it
 * can be unit-tested in isolation and reused with any db (e.g. a transactional
 * client during ingest dedup).
 *
 * @param threshold - The maximum relative distance allowed (0.0 to 1.0, where 0
 *   is a perfect match). Default 0.3 accepts matches at >= 0.7 similarity.
 */
export function bestFuzzyMatch(
  searchName: string,
  candidates: CompanyCandidate[],
  threshold: number = 0.3,
): MatchResult | null {
  const normalizedSearch = searchName.toLowerCase().trim();
  if (!normalizedSearch) return null;

  let bestMatch: MatchResult | null = null;
  let minDistance = Infinity;

  for (const company of candidates) {
    const namesToCheck = [company.target, company.project_name].filter(Boolean) as string[];
    if (namesToCheck.length === 0) continue;

    for (const candidateName of namesToCheck) {
      const normalized = candidateName.toLowerCase().trim();

      if (normalizedSearch === normalized) {
        return { id: company.id, name: candidateName, type: 'company', similarity: 1 };
      }

      const distance = levenshtein.get(normalizedSearch, normalized);
      const relativeDistance = distance / Math.max(normalizedSearch.length, normalized.length);

      if (relativeDistance < minDistance) {
        minDistance = relativeDistance;
        bestMatch = {
          id: company.id,
          name: candidateName,
          type: 'company',
          similarity: 1 - relativeDistance,
        };
      }
    }
  }

  if (bestMatch && 1 - bestMatch.similarity <= threshold) {
    return bestMatch;
  }

  return null;
}

/**
 * Finds the best matching company name using Levenshtein distance over ALL
 * companies. Thin I/O wrapper around {@link bestFuzzyMatch} for the
 * `fuzzy_search_company` agent tool.
 * @param searchName - The name extracted from the document
 * @param threshold - The maximum relative distance allowed (0.0 to 1.0, where 0 is perfect match)
 * @returns The best match found or null
 */
export async function findBestCompanyMatch(
  searchName: string,
  threshold: number = 0.3,
): Promise<MatchResult | null> {
  const db = createDb();
  const companyRepo = new CompanyRepository(db, await getActiveWorkspaceId());
  const companies = await companyRepo.findAllIdAndTarget();
  return bestFuzzyMatch(searchName, companies, threshold);
}

/**
 * Fetches all company targets and project names from the database.
 * Usage: Inject this list into the LLM context so it knows what companies exist.
 */
export async function getAllCompanyReferences(): Promise<MatchResult[]> {
  const db = createDb();
  const companyRepo = new CompanyRepository(db, await getActiveWorkspaceId());

  const companies = await companyRepo.findAllIdAndTarget();

  const matches: MatchResult[] = [];

  for (const company of companies) {
    if (!company.target && !company.project_name) continue;
    // Expose target and project_name as separate lookup entries so the LLM
    // can detect a company by either its legal name or its project codename.
    if (company.target) {
      matches.push({ id: company.id, name: company.target, type: 'company', similarity: 1 });
    }
    if (company.project_name) {
      matches.push({ id: company.id, name: company.project_name, type: 'company', similarity: 1 });
    }
  }

  return matches;
}
