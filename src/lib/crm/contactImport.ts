/**
 * Parsing + validation for the CRM contact import (CSV here; Excel in
 * `contactImportExcel.ts`, which feeds `parseContactTable`). Pure and dependency-free
 * so the same code runs in the browser (preview before upload) and in the API
 * route (re-validating the untrusted body before `CRMService.importContacts`).
 */

/** One contact row as accepted by `CRMService.importContacts`. */
export interface ImportContactRow {
  name: string;
  /** Free-text firm name; find-or-created as an employer. */
  firm?: string;
  email?: string;
  phone?: string;
  title?: string;
  type?: string;
  department?: string;
  specialization?: string;
  seniority?: string;
  coverageRegion?: string;
  linkedinUrl?: string;
  bio?: string;
}

export type ImportContactField = keyof ImportContactRow;

/**
 * Rows per `POST /api/crm/contacts/import` request. Not a cap on the file —
 * the client sends a large file as consecutive batches of `IMPORT_BATCH_SIZE`
 * (`chunkRows`); the route rejects anything above `MAX_IMPORT_BATCH` so one
 * request stays inside a single serverless body/time budget.
 */
export const IMPORT_BATCH_SIZE = 500;
export const MAX_IMPORT_BATCH = 1000;

const FIELDS: readonly ImportContactField[] = [
  "name",
  "firm",
  "email",
  "phone",
  "title",
  "type",
  "department",
  "specialization",
  "seniority",
  "coverageRegion",
  "linkedinUrl",
  "bio",
];

/**
 * Header spellings accepted for each field, compared after lowercasing and
 * stripping everything but letters/digits (so "E-mail Address", "email_address"
 * and "Email Address" all resolve to `email`).
 */
const HEADER_ALIASES: Record<ImportContactField, string[]> = {
  name: ["name", "fullname", "contactname", "contact", "contactperson", "person", "displayname"],
  firm: [
    "firm", "firmname", "company", "companyname", "employer", "organization",
    "organisation", "org", "bank", "bankname", "institution", "account", "accountname",
  ],
  email: [
    "email", "emailaddress", "mail", "workemail", "businessemail", "primaryemail",
    "email1", "emailaddress1", "officeemail",
  ],
  phone: [
    "phone", "phonenumber", "mobile", "mobilephone", "mobilenumber", "telephone", "tel",
    "cell", "cellphone", "workphone", "businessphone", "officephone", "directline", "whatsapp",
  ],
  title: ["title", "jobtitle", "position", "role", "designation", "jobposition"],
  type: ["type", "contacttype", "category", "relationship", "relationshiptype"],
  department: ["department", "desk", "team", "division", "group", "businessunit", "practice"],
  specialization: [
    "specialization", "specialisation", "sector", "sectors", "coverage", "sectorcoverage",
    "industrycoverage", "focus", "expertise", "productcoverage",
  ],
  seniority: ["seniority", "level", "rank", "grade"],
  coverageRegion: ["coverageregion", "region", "geography", "territory", "market", "coveragearea"],
  linkedinUrl: [
    "linkedin", "linkedinurl", "linkedinprofile", "linkedinprofileurl", "linkedinlink",
    "profileurl",
  ],
  bio: ["bio", "notes", "note", "biography", "about", "description", "summary", "comments", "remarks", "background"],
};

const FIRST_NAME_ALIASES = ["firstname", "givenname", "first"];
const LAST_NAME_ALIASES = ["lastname", "surname", "familyname", "last"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The contact field a column header maps to, or null when unrecognised. */
export function fieldForHeader(header: string): ImportContactField | null {
  const key = headerKey(header);
  return FIELDS.find((f) => HEADER_ALIASES[f].includes(key)) ?? null;
}

/** Lowercased, trimmed email, or undefined when blank. */
export function normalizeEmail(email: string | null | undefined): string | undefined {
  const e = email?.trim().toLowerCase();
  return e ? e : undefined;
}

/**
 * Minimal RFC 4180 CSV reader: quoted fields, escaped `""`, embedded commas and
 * newlines, CRLF line endings and a leading BOM. Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
    field = "";
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

export interface ParsedContactFile {
  rows: ImportContactRow[];
  /** Field → the header it was read from; unmapped fields are omitted. */
  mappedHeaders: Partial<Record<ImportContactField, string>>;
  /** Headers with no matching field — their values are kept in `bio`. */
  extraHeaders: string[];
  /** Human-readable problems, each prefixed with the 1-based row number. */
  errors: string[];
}

/**
 * Maps a sheet (first row = headers) onto validated import rows. Shared by the
 * CSV and Excel readers. A `name` column is optional when `first name` /
 * `last name` columns exist. Columns that match no field are not dropped:
 * their non-blank values are appended to `bio` as `Header: value` lines, so
 * details the CRM has no dedicated field for still land on the contact.
 */
export function parseContactTable(table: string[][]): ParsedContactFile {
  if (table.length === 0) {
    return { rows: [], mappedHeaders: {}, extraHeaders: [], errors: ["The file is empty."] };
  }

  const [headers, ...body] = table;
  const keys = headers.map(headerKey);
  const colOf: Partial<Record<ImportContactField, number>> = {};
  const mappedHeaders: Partial<Record<ImportContactField, string>> = {};
  const used = new Set<number>();
  for (const field of FIELDS) {
    const idx = keys.findIndex((k) => HEADER_ALIASES[field].includes(k));
    if (idx >= 0) {
      colOf[field] = idx;
      mappedHeaders[field] = headers[idx].trim();
      used.add(idx);
    }
  }
  const firstCol = keys.findIndex((k) => FIRST_NAME_ALIASES.includes(k));
  const lastCol = keys.findIndex((k) => LAST_NAME_ALIASES.includes(k));
  if (firstCol >= 0) used.add(firstCol);
  if (lastCol >= 0) used.add(lastCol);
  const extraCols = headers
    .map((h, i) => ({ header: h.trim(), i }))
    .filter(({ header, i }) => header && !used.has(i));

  if (colOf.name === undefined && firstCol < 0 && lastCol < 0) {
    return {
      rows: [],
      mappedHeaders,
      extraHeaders: extraCols.map((c) => c.header),
      errors: ['Missing a "Name" (or "First name" / "Last name") column.'],
    };
  }

  const raw = body.map((cells) => {
    const out: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const idx = colOf[field];
      if (idx !== undefined) out[field] = cells[idx];
    }
    if (colOf.name === undefined || !String(out.name ?? "").trim()) {
      out.name = [firstCol, lastCol]
        .filter((i) => i >= 0)
        .map((i) => cells[i]?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
    }
    const extras = extraCols
      .map(({ header, i }) => [header, cells[i]?.trim() ?? ""] as const)
      .filter(([, v]) => v)
      .map(([h, v]) => `${h}: ${v}`);
    if (extras.length > 0) {
      out.bio = [String(out.bio ?? "").trim(), ...extras].filter(Boolean).join("\n");
    }
    return out;
  });

  // Row numbers are 1-based and count the header row.
  const { rows, errors } = sanitizeImportRows(raw, 2);
  return {
    rows,
    mappedHeaders,
    extraHeaders: extraCols.map((c) => c.header),
    errors,
  };
}

/** Parses a contacts CSV (first row = headers) into validated import rows. */
export function parseContactCsv(text: string): ParsedContactFile {
  return parseContactTable(parseCsv(text));
}

/**
 * Collapses rows sharing an email (case-insensitive) into one, later rows
 * filling in fields the earlier ones left out. Rows without an email pass
 * through untouched. Run before batching so a repeat that lands in a later
 * batch is still folded into the same contact.
 */
export function collapseByEmail(rows: ImportContactRow[]): {
  rows: ImportContactRow[];
  duplicates: number;
} {
  const out: ImportContactRow[] = [];
  const indexByEmail = new Map<string, number>();
  let duplicates = 0;
  for (const row of rows) {
    const email = normalizeEmail(row.email);
    if (!email) {
      out.push(row);
      continue;
    }
    const filled = Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== undefined && v !== ""),
    ) as Partial<ImportContactRow>;
    const at = indexByEmail.get(email);
    if (at === undefined) {
      indexByEmail.set(email, out.length);
      out.push({ ...row, ...filled, email } as ImportContactRow);
    } else {
      duplicates++;
      out[at] = { ...out[at], ...filled, email };
    }
  }
  return { rows: out, duplicates };
}

/** Splits rows into consecutive batches of at most `size`. */
export function chunkRows<T>(rows: T[], size = IMPORT_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Narrows an untrusted array (CSV-parsed rows or a JSON request body) to valid
 * `ImportContactRow`s: strings only, trimmed, blanks dropped, email lowercased.
 * A row with no name — or with a malformed email — is rejected with an error
 * rather than imported half-right. `lineOffset` maps index → reported line.
 */
export function sanitizeImportRows(
  input: unknown,
  lineOffset = 1,
): { rows: ImportContactRow[]; errors: string[] } {
  if (!Array.isArray(input)) {
    return { rows: [], errors: ["Expected a list of contacts."] };
  }
  const rows: ImportContactRow[] = [];
  const errors: string[] = [];
  input.forEach((item, i) => {
    const line = i + lineOffset;
    if (!item || typeof item !== "object") {
      errors.push(`Row ${line}: not a contact.`);
      return;
    }
    const rec = item as Record<string, unknown>;
    const row: Partial<ImportContactRow> = {};
    for (const field of FIELDS) {
      const v = rec[field];
      if (typeof v !== "string") continue;
      const trimmed = v.trim();
      if (trimmed) row[field] = trimmed;
    }
    if (!row.name) {
      errors.push(`Row ${line}: name is required.`);
      return;
    }
    if (row.email !== undefined) {
      row.email = normalizeEmail(row.email);
      if (row.email && !EMAIL_RE.test(row.email)) {
        errors.push(`Row ${line}: "${row.email}" is not a valid email.`);
        return;
      }
    }
    rows.push(row as ImportContactRow);
  });
  return { rows, errors };
}
