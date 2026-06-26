import posthog from 'posthog-js';
import { companyDisplayName } from '@/lib/companyDisplay';
import { getCriterias, prepareScreenings } from '@/lib/api/pipeline';
import type { PipelineCompany } from '@/views/Pipeline';

export interface AIScreeningCompanyInput {
  id: string;
  target?: string | null;
  project_name?: string | null;
  segment?: string | null;
  geography?: string | null;
  company_focus?: string | null;
  ownership?: string | null;
  website?: string | null;
  revenue_2022_usd_mn?: number | null;
  revenue_2023_usd_mn?: number | null;
  revenue_2024_usd_mn?: number | null;
  ebitda_2022_usd_mn?: number | null;
  ebitda_2023_usd_mn?: number | null;
  ebitda_2024_usd_mn?: number | null;
  ev_2024?: number | null;
}

export interface AIScreeningCriterion {
  id: string;
  name: string;
  prompt: string;
}

export function toAIScreeningCompany(company: PipelineCompany): AIScreeningCompanyInput {
  return {
    id: company.id,
    target: company.target,
    project_name: company.project_name,
    segment: company.segment,
    geography: company.geography,
    ownership: company.ownership,
    website: company.website,
    revenue_2022_usd_mn: company.revenue_2022_usd_mn,
    revenue_2023_usd_mn: company.revenue_2023_usd_mn,
    revenue_2024_usd_mn: company.revenue_2024_usd_mn,
    ebitda_2022_usd_mn: company.ebitda_2022_usd_mn,
    ebitda_2023_usd_mn: company.ebitda_2023_usd_mn,
    ebitda_2024_usd_mn: company.ebitda_2024_usd_mn,
    ev_2024: company.ev_2024,
  };
}

export async function runAIScreeningForCompanies(
  companies: AIScreeningCompanyInput[],
  criteria?: AIScreeningCriterion[],
): Promise<{ companyCount: number; criteriaCount: number }> {
  const resolvedCriteria = criteria ?? (await getCriterias());

  if (resolvedCriteria.length === 0) {
    throw new Error('Please add at least one screening criterion');
  }

  if (companies.length === 0) {
    throw new Error('No companies selected for screening');
  }

  const screeningEntries = await prepareScreenings(
    companies.map((c) => c.id),
    resolvedCriteria.map((c) => c.id),
  );

  posthog.capture('ai_screening_started', {
    company_count: companies.length,
    criteria_count: resolvedCriteria.length,
    total_screenings: screeningEntries.length,
  });

  screeningEntries.forEach((entry) => {
    const company = companies.find((c) => c.id === entry.company_id);
    const criterion = resolvedCriteria.find((c) => c.id === entry.criteria_id);

    if (!company || !criterion) return;

    void fetch('/api/ai-screening', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyId: company.id,
        criteriaId: criterion.id,
        criteriaPrompt: criterion.prompt,
        screeningId: entry.id,
        company: {
          id: company.id,
          name: companyDisplayName(company, ''),
          segment: company.segment,
          geography: company.geography,
          company_focus: company.company_focus,
          ownership: company.ownership,
          website: company.website,
          revenue_2022_usd_mn: company.revenue_2022_usd_mn,
          revenue_2023_usd_mn: company.revenue_2023_usd_mn,
          revenue_2024_usd_mn: company.revenue_2024_usd_mn,
          ebitda_2022_usd_mn: company.ebitda_2022_usd_mn,
          ebitda_2023_usd_mn: company.ebitda_2023_usd_mn,
          ebitda_2024_usd_mn: company.ebitda_2024_usd_mn,
          ev_2024: company.ev_2024,
        },
      }),
    }).catch((err) => {
      console.error(`Failed to dispatch screening ${company.id}/${criterion.id}:`, err);
    });
  });

  return {
    companyCount: companies.length,
    criteriaCount: resolvedCriteria.length,
  };
}
