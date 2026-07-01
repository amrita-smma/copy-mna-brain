import posthog from 'posthog-js';
import { companyDisplayName } from '@/lib/companyDisplay';
import { getCriterias, prepareScreenings } from '@/lib/api/pipeline';
import {
  buildTrackScreeningGroups,
  type TrackLike,
} from '@/lib/tracks/matchTracks';
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
  matched_track_ids?: string[];
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
    matched_track_ids: company.matched_track_ids ?? [],
  };
}

/**
 * Run AI screening for a single company against its matched tracks. Each matched
 * track is screened using the criteria that belong to it
 * (`criterias.investment_thesis_id`); tracks with no criteria are skipped,
 * producing one screening group per screenable track — so a company matched to
 * 3 tracks adds 3 groups to the AI Screening Progress panel.
 */
export async function runAIScreeningForCompanyTracks(
  company: AIScreeningCompanyInput,
  tracks: TrackLike[],
): Promise<{ trackCount: number; screeningCount: number }> {
  const allCriteria = await getCriterias();
  const criteriaById = new Map(allCriteria.map((c) => [c.id, c]));

  // One group per matched track, carrying that track's own criteria.
  const groups = buildTrackScreeningGroups(company, tracks, allCriteria);

  if (groups.length === 0) {
    throw new Error(
      'No matched track with screening criteria — assign criteria to a matched track first',
    );
  }

  const screeningEntries = await prepareScreenings(
    groups.map((g) => ({
      companyId: company.id,
      trackId: g.trackId,
      criteriaIds: g.criteriaIds,
    })),
  );

  posthog.capture('ai_screening_started', {
    company_count: 1,
    track_count: groups.length,
    total_screenings: screeningEntries.length,
  });

  screeningEntries.forEach((entry) => {
    const criterion = criteriaById.get(entry.criteria_id);
    if (!criterion) return;

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

  return { trackCount: groups.length, screeningCount: screeningEntries.length };
}
