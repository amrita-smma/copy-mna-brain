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

/**
 * Build up-to-two-letter initials from a name using only English (A–Z) letters.
 *
 * For each word (whitespace-separated), the word's initial is its FIRST English
 * letter appearing anywhere in the word — so a leading digit, symbol or
 * non-Latin character is skipped rather than shown. Words with no English letter
 * at all (e.g. purely CJK / Cyrillic / emoji / punctuation) contribute nothing.
 *
 * The first two qualifying words give a two-letter avatar. If only one word has
 * an English letter, the avatar is that single letter. If none do, `fallback`
 * is returned.
 */
export function nameInitials(name: string | null | undefined, fallback = "U") {
  const letters: string[] = [];
  for (const word of clean(name).split(/\s+/)) {
    const letter = word.match(/[A-Za-z]/)?.[0];
    if (!letter) continue;
    letters.push(letter.toUpperCase());
    if (letters.length === 2) break;
  }
  return letters.length > 0 ? letters.join("") : fallback;
}

export function companyInitials(company: CompanyNameLike | null | undefined, fallback = "U") {
  return nameInitials(companyDisplayName(company, fallback), fallback);
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
