import * as crypto from 'node:crypto';

export interface VaultCredentials {
  client_email: string;
  private_key: string;
  project_id: string;
}

export interface ParsedEmail {
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  body: string;
  sent_at: string | null;
}

export interface VaultExportFile {
  bucketName: string;
  objectName: string;
  size: string;
}

export interface VaultExportStatus {
  id: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  files: VaultExportFile[];
}

export interface VaultImportMessage {
  contact_email: string;
  contact_name?: string;
  direction: 'inbound' | 'outbound';
  subject?: string;
  body: string;
  sent_at?: string;
  from_email?: string;
  to_email?: string;
}

const VAULT_BASE = 'https://vault.googleapis.com/v1';
const STORAGE_DOWNLOAD_BASE = 'https://storage.googleapis.com/download/storage/v1';

export function loadVaultCredentials(): VaultCredentials {
  const encoded = process.env.GOOGLE_VAULT_SERVICE_ACCOUNT;
  if (!encoded) throw new Error('GOOGLE_VAULT_SERVICE_ACCOUNT is not set');
  const json = Buffer.from(encoded, 'base64').toString('utf-8');
  const creds = JSON.parse(json) as VaultCredentials;
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Invalid service account JSON: missing client_email or private_key');
  }
  return creds;
}

function makeJwt(clientEmail: string, privateKey: string, scopes: string[], subject?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimsObj: Record<string, unknown> = {
    iss: clientEmail,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  if (subject) claimsObj.sub = subject;
  const payload = Buffer.from(JSON.stringify(claimsObj)).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign({ key: privateKey, format: 'pem' }, 'base64url');
  return `${unsigned}.${signature}`;
}

export async function getVaultAccessToken(creds: VaultCredentials, subject?: string): Promise<string> {
  const jwt = makeJwt(
    creds.client_email,
    creds.private_key,
    [
      'https://www.googleapis.com/auth/ediscovery',
      'https://www.googleapis.com/auth/devstorage.read_only',
    ],
    subject,
  );
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Failed to get Google access token: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

async function vaultRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(`${VAULT_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Vault API error ${resp.status} on ${method} ${path}: ${err}`);
  }
  return resp.json() as Promise<T>;
}

export async function createVaultMatter(token: string): Promise<string> {
  const matter = await vaultRequest<{ matterId: string }>(token, 'POST', '/matters', {
    name: `MNA Tracker Email Sync ${new Date().toISOString()}`,
    description: 'Automated daily email export',
    state: 'OPEN',
  });
  return matter.matterId;
}

export async function createVaultExport(
  token: string,
  matterId: string,
  custodianEmails: string[],
  startTime: Date,
  endTime: Date,
): Promise<string> {
  const exportObj = await vaultRequest<{ id: string }>(
    token,
    'POST',
    `/matters/${matterId}/exports`,
    {
      name: `Email Export ${new Date().toISOString()}`,
      query: {
        corpus: 'MAIL',
        dataScope: 'ALL_DATA',
        searchMethod: 'ACCOUNT',
        accountInfo: { emails: custodianEmails },
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        mailOptions: { excludeDrafts: false },
      },
      exportOptions: {
        mailOptions: {
          exportFormat: 'MBOX',
          showConfidentialModeContent: false,
          exportLinkedDriveFiles: false,
          useNewExport: true,
        },
      },
    },
  );
  return exportObj.id;
}

export async function pollVaultExport(
  token: string,
  matterId: string,
  exportId: string,
): Promise<VaultExportStatus> {
  const data = await vaultRequest<{
    id: string;
    status: string;
    cloudStorageSink?: { files?: Array<{ bucketName: string; objectName: string; size: string }> };
  }>(token, 'GET', `/matters/${matterId}/exports/${exportId}`);

  const files: VaultExportFile[] = data.cloudStorageSink?.files ?? [];
  const status = data.status as VaultExportStatus['status'];
  return { id: data.id, status, files };
}

export async function closeVaultMatter(token: string, matterId: string): Promise<void> {
  await vaultRequest(token, 'POST', `/matters/${matterId}:close`, {});
}

export async function downloadExportFile(token: string, file: VaultExportFile): Promise<Buffer> {
  const encodedObject = encodeURIComponent(file.objectName);
  const url = `${STORAGE_DOWNLOAD_BASE}/b/${file.bucketName}/o/${encodedObject}?alt=media`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to download export file ${file.objectName}: ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

// ─── MBOX + MIME parsing ──────────────────────────────────────────────────────

function decodeHeaderWord(encoded: string): string {
  // Decode =?charset?B?base64?= and =?charset?Q?qp?= encoded words
  return encoded.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      } else {
        const qp = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
        return qp;
      }
    } catch {
      return text;
    }
  });
}

function parseHeaders(raw: string): Record<string, string> {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = decodeHeaderWord(line.slice(colon + 1).trim());
    if (!headers[key]) headers[key] = value;
  }
  return headers;
}

function extractEmailAddress(header: string): string | null {
  const angle = header.match(/<([^>@\s]+@[^>@\s]+)>/);
  if (angle) return angle[1].trim();
  const bare = header.match(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return bare ? bare[0].trim() : null;
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeTransfer(body: string, encoding: string): string {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTextFromMime(
  headers: Record<string, string>,
  rawBody: string,
): string {
  const contentType = headers['content-type'] ?? 'text/plain';
  const transferEncoding = headers['content-transfer-encoding'] ?? '';

  if (contentType.startsWith('multipart/')) {
    const boundaryMatch = contentType.match(/boundary="?([^";,\s]+)"?/i);
    if (!boundaryMatch) return rawBody.trim();

    const boundary = boundaryMatch[1];
    const parts = rawBody.split(`--${boundary}`);
    let textPart: string | null = null;
    let htmlPart: string | null = null;

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === '--') continue;
      const divider = trimmed.indexOf('\n\n');
      if (divider === -1) continue;
      const partHeaders = parseHeaders(trimmed.slice(0, divider));
      const partBody = trimmed.slice(divider + 2);
      const partCT = partHeaders['content-type'] ?? '';
      const partTE = partHeaders['content-transfer-encoding'] ?? '';

      if (partCT.startsWith('multipart/')) {
        const nested = extractTextFromMime(partHeaders, partBody);
        if (nested && !textPart) textPart = nested;
      } else if (partCT.startsWith('text/plain') && !textPart) {
        textPart = decodeTransfer(partBody, partTE).trim();
      } else if (partCT.startsWith('text/html') && !htmlPart) {
        htmlPart = stripHtml(decodeTransfer(partBody, partTE));
      }
    }

    return textPart ?? htmlPart ?? rawBody.trim();
  }

  const decoded = decodeTransfer(rawBody, transferEncoding);
  if (contentType.startsWith('text/html')) return stripHtml(decoded);
  return decoded.trim();
}

function parseMessageDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

export function parseMboxContent(mboxContent: string): ParsedEmail[] {
  const emails: ParsedEmail[] = [];

  // Normalize CRLF → LF so all parsing logic only deals with \n
  const content = mboxContent.replace(/\r\n/g, '\n');

  // Split on mbox message boundaries (lines starting with "From ")
  const boundaries: number[] = [];
  const re = /^From \S/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    boundaries.push(m.index);
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : content.length;
    const msgText = content.slice(start, end);

    // Skip the From_ envelope line
    const firstNewline = msgText.indexOf('\n');
    if (firstNewline === -1) continue;
    const msgBody = msgText.slice(firstNewline + 1);

    // Split headers from body
    const hbDivider = msgBody.indexOf('\n\n');
    if (hbDivider === -1) continue;

    const rawHeaders = msgBody.slice(0, hbDivider);
    const rawBodyContent = msgBody.slice(hbDivider + 2);

    const headers = parseHeaders(rawHeaders);
    const body = extractTextFromMime(headers, rawBodyContent);

    // Unescape MBOX-escaped ">From " lines in the body
    const cleanBody = body.replace(/^>From /gm, 'From ');

    if (!cleanBody.trim()) continue;

    emails.push({
      from_email: extractEmailAddress(headers['from'] ?? ''),
      to_email: extractEmailAddress(headers['to'] ?? ''),
      subject: headers['subject'] ?? null,
      body: cleanBody,
      sent_at: parseMessageDate(headers['date']),
    });
  }

  return emails;
}

export function classifyEmails(
  emails: ParsedEmail[],
  custodianEmails: Set<string>,
): VaultImportMessage[] {
  const result: VaultImportMessage[] = [];

  for (const email of emails) {
    const fromLower = email.from_email?.toLowerCase() ?? '';
    const toLower = email.to_email?.toLowerCase() ?? '';
    const fromIsCustodian = custodianEmails.has(fromLower);
    const toIsCustodian = custodianEmails.has(toLower);

    let contactEmail: string | null = null;
    let direction: 'inbound' | 'outbound';

    if (fromIsCustodian && !toIsCustodian) {
      direction = 'outbound';
      contactEmail = email.to_email;
    } else if (!fromIsCustodian && toIsCustodian) {
      direction = 'inbound';
      contactEmail = email.from_email;
    } else if (fromIsCustodian && toIsCustodian) {
      // Internal email between custodians — skip
      continue;
    } else {
      // Neither party is a custodian — likely a CC'd email, skip
      continue;
    }

    if (!contactEmail) continue;

    result.push({
      contact_email: contactEmail,
      direction,
      subject: email.subject ?? undefined,
      body: email.body,
      sent_at: email.sent_at ?? undefined,
      from_email: email.from_email ?? undefined,
      to_email: email.to_email ?? undefined,
    });
  }

  return result;
}
