import { companyDisplayName } from '@/lib/companyDisplay';

export interface PresentationCompanyFields {
  target?: string | null;
  project_name?: string | null;
  name?: string | null;
  segment?: string | null;
  geography?: string | null;
  ownership?: string | null;
  company_focus?: string | null;
  website?: string | null;
  comments?: string | null;
  remarks?: string | null;
  revenue_2024_usd_mn?: number | null;
  ebitda_2024_usd_mn?: number | null;
  ev_2024?: number | null;
  ebitda_margin_2024?: number | null;
  l1_screening_result?: string | null;
}

export interface PresentationCompanyAnalysis {
  business_overview?: string | null;
  business_model_summary?: string | null;
  key_takeaways?: string | null;
  investment_highlights?: string | null;
  investment_risks?: string | null;
  diligence_priorities?: string | null;
}

const MAX_FIELD = 2_500;

function truncateField(value: string, max = MAX_FIELD): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Compact structured context for optional company_names on presentation specs. */
export function buildPresentationCompanyContext(
  company: PresentationCompanyFields,
  analysis: PresentationCompanyAnalysis | null,
): string {
  const lines: string[] = [];
  lines.push(`Company: ${companyDisplayName(company)}`);
  if (company.segment) lines.push(`Segment: ${company.segment}`);
  if (company.geography) lines.push(`Geography: ${company.geography}`);
  if (company.ownership) lines.push(`Ownership: ${company.ownership}`);
  if (company.company_focus) lines.push(`Focus: ${company.company_focus}`);
  if (company.website) lines.push(`Website: ${company.website}`);
  if (company.comments) lines.push(`Comments: ${company.comments}`);
  if (company.remarks) lines.push(`Remarks: ${company.remarks}`);

  const fin: string[] = [];
  if (company.revenue_2024_usd_mn != null) fin.push(`Rev 2024: $${company.revenue_2024_usd_mn}M`);
  if (company.ebitda_2024_usd_mn != null) fin.push(`EBITDA 2024: $${company.ebitda_2024_usd_mn}M`);
  if (company.ev_2024 != null) fin.push(`EV 2024: $${company.ev_2024}M`);
  if (company.ebitda_margin_2024 != null) {
    fin.push(`EBITDA Margin 2024: ${(company.ebitda_margin_2024 * 100).toFixed(1)}%`);
  }
  if (fin.length > 0) lines.push(`Financials: ${fin.join(' | ')}`);
  if (company.l1_screening_result) lines.push(`L1 Result: ${company.l1_screening_result}`);

  if (analysis) {
    if (analysis.business_overview) {
      lines.push(`\nBusiness Overview:\n${truncateField(analysis.business_overview)}`);
    }
    if (analysis.business_model_summary) {
      lines.push(`\nBusiness Model:\n${truncateField(analysis.business_model_summary)}`);
    }
    if (analysis.key_takeaways) {
      lines.push(`\nKey Takeaways:\n${truncateField(analysis.key_takeaways)}`);
    }
    if (analysis.investment_highlights) {
      lines.push(`\nInvestment Highlights:\n${truncateField(analysis.investment_highlights)}`);
    }
    if (analysis.investment_risks) {
      lines.push(`\nInvestment Risks:\n${truncateField(analysis.investment_risks)}`);
    }
    if (analysis.diligence_priorities) {
      lines.push(`\nDiligence Priorities:\n${truncateField(analysis.diligence_priorities)}`);
    }
  }

  return lines.join('\n');
}
