type CompanyNameLike = {
  target?: string | null;
  name?: string | null;
  project_name?: string | null;
};

const clean = (value: string | null | undefined) => value?.trim() || "";

export function companyDisplayName(
  company: CompanyNameLike | null | undefined,
  fallback = "Unknown",
) {
  return clean(company?.target) || clean(company?.name) || clean(company?.project_name) || fallback;
}

export function companyInitials(company: CompanyNameLike | null | undefined, fallback = "U") {
  return companyDisplayName(company, fallback)
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}
