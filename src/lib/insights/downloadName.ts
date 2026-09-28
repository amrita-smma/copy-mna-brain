/** The longest slug a download file name keeps, before `.html`. */
const MAX_SLUG_LENGTH = 80;

/**
 * The file name "Download HTML" saves an insight under: its name slugified
 * (lower case, runs of anything but letters and digits become one hyphen)
 * plus `.html`. Letters and digits of any script are kept, so a Chinese or
 * Indonesian name stays readable; a name with none falls back to `insight`.
 */
export function insightHtmlFileName(name: string): string {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return `${slug || 'insight'}.html`;
}
