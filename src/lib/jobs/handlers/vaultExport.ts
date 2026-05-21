import {
  loadVaultCredentials,
  getVaultAccessToken,
  createVaultMatter,
  createVaultExport,
  pollVaultExport,
  downloadExportFile,
  parseMboxContent,
  classifyEmails,
  closeVaultMatter,
} from '@/lib/services/googleVaultService';
import {
  ContactRepository,
  ContactMessageRepository,
} from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';

export const VAULT_EXPORT_TIMEOUT_SECONDS = 1800; // 30 minutes

export const VAULT_CUSTODIAN_EMAILS = [
  'hendric.g@starcapital.co.id',
  'dessi.sari@aldiracita.com',
  'jien.lit@starcapital.co.id',
  'zhang.hongtao@starcapital.co.id',
  'cp.tei@starcapitalholdings.com',
  'samuel.nathaniel@lifewithsun.com',
  'christin.chandra@starcapital.co.id',
  'chandra.limi@starcapital.co.id',
];

export interface VaultExportPayload {
  custodianEmails?: string[];
  daysBack?: number;
}

export interface VaultExportResult {
  matters_created: number;
  files_downloaded: number;
  emails_parsed: number;
  contacts_created: number;
  messages_added: number;
}

const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 55; // 55 × 30s ≈ 27.5 minutes

export async function runVaultExport(
  payload: VaultExportPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<VaultExportResult> {
  const custodianEmails = payload.custodianEmails ?? VAULT_CUSTODIAN_EMAILS;
  const daysBack = payload.daysBack ?? 1;

  const creds = loadVaultCredentials();
  const token = await getVaultAccessToken(creds);

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const matterId = await createVaultMatter(token);
  let exportId: string;

  try {
    exportId = await createVaultExport(token, matterId, custodianEmails, startTime, endTime);
  } catch (err) {
    await closeVaultMatter(token, matterId).catch(() => undefined);
    throw err;
  }

  // Poll until export completes
  let exportFiles: Awaited<ReturnType<typeof pollVaultExport>>['files'] = [];
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const status = await pollVaultExport(token, matterId, exportId);
    if (status.status === 'COMPLETED') {
      exportFiles = status.files;
      break;
    }
    if (status.status === 'FAILED') {
      await closeVaultMatter(token, matterId).catch(() => undefined);
      throw new Error(`Vault export ${exportId} failed`);
    }
    if (attempt < MAX_POLL_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  if (exportFiles.length === 0) {
    await closeVaultMatter(token, matterId).catch(() => undefined);
    throw new Error('Vault export did not complete within the timeout window');
  }

  // Download, parse, and import
  const custodianSet = new Set(custodianEmails.map((e) => e.toLowerCase()));
  const contactRepo = new ContactRepository(deps.db);
  const messageRepo = new ContactMessageRepository(deps.db);

  let filesDownloaded = 0;
  let emailsParsed = 0;
  let contactsCreated = 0;
  let messagesAdded = 0;

  for (const file of exportFiles) {
    // Only process MBOX files
    if (!file.objectName.endsWith('.mbox')) continue;

    const mboxContent = await downloadExportFile(token, file);
    filesDownloaded++;

    const parsed = parseMboxContent(mboxContent);
    const classified = classifyEmails(parsed, custodianSet);
    emailsParsed += parsed.length;

    for (const msg of classified) {
      let contact = await contactRepo.findByEmail(msg.contact_email);
      if (!contact) {
        contact = await contactRepo.insert({
          email: msg.contact_email,
          name: msg.contact_email,
        });
        contactsCreated++;
      }

      await messageRepo.insert({
        contact_id: contact.id,
        direction: msg.direction,
        subject: msg.subject,
        body: msg.body,
        sent_at: msg.sent_at,
        from_email: msg.from_email,
        to_email: msg.to_email,
        metadata: { source: 'google_vault', matter_id: matterId, export_id: exportId },
      });
      messagesAdded++;
    }
  }

  await closeVaultMatter(token, matterId).catch(() => undefined);

  return {
    matters_created: 1,
    files_downloaded: filesDownloaded,
    emails_parsed: emailsParsed,
    contacts_created: contactsCreated,
    messages_added: messagesAdded,
  };
}
