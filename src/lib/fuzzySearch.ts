import levenshtein from 'fast-levenshtein';
import { createDb } from '@/lib/server/db';
import { CompanyRepository, PastAcquisitionRepository } from '@/lib/repositories';

interface MatchResult {
  id: string;
  name: string;
  type: 'company' | 'past_acquisition';
  similarity: number;
}

/**
 * Finds the best matching company or past acquisition name using Levenshtein distance.
 * @param searchName - The name extracted from the document
 * @param threshold - The maximum relative distance allowed (0.0 to 1.0, where 0 is perfect match)
 * @returns The best match found or null
 */
export async function findBestCompanyMatch(
  searchName: string,
  threshold: number = 0.3,
): Promise<MatchResult | null> {
  const db = createDb();
  const companyRepo = new CompanyRepository(db);
  const pastRepo = new PastAcquisitionRepository(db);

  const normalizedSearch = searchName.toLowerCase().trim();
  const [companies, pastDeals] = await Promise.all([
    companyRepo.findAllIdAndTarget(),
    pastRepo.findAllIdAndName(),
  ]);

  let bestMatch: MatchResult | null = null;
  let minDistance = Infinity;

  for (const company of companies) {
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

  for (const deal of pastDeals) {
    if (!deal.project_name) continue;
    const targetName = deal.project_name.toLowerCase().trim();

    if (normalizedSearch === targetName) {
      return {
        id: deal.id,
        name: deal.project_name,
        type: 'past_acquisition',
        similarity: 1,
      };
    }

    const distance = levenshtein.get(normalizedSearch, targetName);
    const relativeDistance = distance / Math.max(normalizedSearch.length, targetName.length);

    if (relativeDistance < minDistance) {
      minDistance = relativeDistance;
      bestMatch = {
        id: deal.id,
        name: deal.project_name,
        type: 'past_acquisition',
        similarity: 1 - relativeDistance,
      };
    }
  }

  if (bestMatch && 1 - bestMatch.similarity <= threshold) {
    return bestMatch;
  }

  return null;
}

/**
 * Fetches all company targets and past acquisition project names from the database.
 * Usage: Inject this list into the LLM context so it knows what companies exist.
 */
export async function getAllCompanyReferences(): Promise<MatchResult[]> {
  const db = createDb();
  const companyRepo = new CompanyRepository(db);
  const pastRepo = new PastAcquisitionRepository(db);

  const [companies, pastDeals] = await Promise.all([
    companyRepo.findAllIdAndTarget(),
    pastRepo.findAllIdAndName(),
  ]);

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

  for (const deal of pastDeals) {
    if (!deal.project_name) continue;
    matches.push({
      id: deal.id,
      name: deal.project_name,
      type: 'past_acquisition',
      similarity: 1,
    });
  }

  return matches;
}
