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

/**
 * Normalize a project name for display, ensuring it reads like "Project X".
 * If the name already begins with "Project" (case-insensitive) it is left as-is,
 * otherwise it is prefixed with "Project ".
 */
export function formatProjectName(projectName: string | null | undefined) {
  const name = clean(projectName);
  if (!name) return "";
  return /^project\b/i.test(name) ? name : `Project ${name}`;
}

/**
 * Consolidated company + project title for tables and card titles (NOT for the
 * database or company card detail fields, where the two stay separate).
 *
 *   Company | Project | result
 *   yes     | yes     | "Company A [Project B]"
 *   yes     | no      | "Company A"
 *   no      | yes     | "[Project B]"
 *   no      | no      | fallback
 */
export function companyDisplayTitle(
  company: CompanyNameLike | null | undefined,
  fallback = "Unknown",
) {
  const name = clean(company?.target) || clean(company?.name);
  const project = formatProjectName(company?.project_name);
  if (name && project) return `${name} [${project}]`;
  if (name) return name;
  if (project) return `[${project}]`;
  return fallback;
}
