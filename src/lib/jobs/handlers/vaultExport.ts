import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
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

const log = (msg: string) => console.log(`[vault-export] ${msg}`);
const debug = (msg: string) => console.debug(`[vault-export] ${msg}`);

export async function runVaultExport(
  payload: VaultExportPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<VaultExportResult> {
  const custodianEmails = payload.custodianEmails ?? VAULT_CUSTODIAN_EMAILS;
  const daysBack = payload.daysBack ?? 5;

  log(`starting job=${deps.job.id} custodians=${custodianEmails.length} daysBack=${daysBack}`);

  const creds = loadVaultCredentials();
  const subject = process.env.GOOGLE_VAULT_IMPERSONATE ?? 'crm.vault@starcapital.co.id';
  log(`authenticating as ${creds.client_email} impersonating ${subject}`);
  const token = await getVaultAccessToken(creds, subject);
  log('access token obtained');

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - daysBack * 24 * 60 * 60 * 1000);
  log(`export window: ${startTime.toISOString()} → ${endTime.toISOString()}`);

  let matterId: string;
  try {
    matterId = await createVaultMatter(token);
    log(`matter created: ${matterId}`);
  } catch (err) {
    console.error('[vault-export] failed to create matter:', err);
    throw err;
  }

  let exportId: string;
  try {
    exportId = await createVaultExport(token, matterId, custodianEmails, startTime, endTime);
    log(`export created: ${exportId}`);
  } catch (err) {
    console.error('[vault-export] failed to create export:', err);
    await closeVaultMatter(token, matterId).catch(() => undefined);
    throw err;
  }

  // Poll until export completes
  let exportFiles: Awaited<ReturnType<typeof pollVaultExport>>['files'] = [];
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    let status: Awaited<ReturnType<typeof pollVaultExport>>;
    try {
      status = await pollVaultExport(token, matterId, exportId);
    } catch (err) {
      console.error(`[vault-export] poll attempt ${attempt + 1} failed:`, err);
      await closeVaultMatter(token, matterId).catch(() => undefined);
      throw err;
    }

    log(`poll attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}: status=${status.status}`);

    if (status.status === 'COMPLETED') {
      exportFiles = status.files;
      log(`export completed with ${exportFiles.length} file(s)`);
      break;
    }
    if (status.status === 'FAILED') {
      console.error(`[vault-export] export ${exportId} failed on Google's side`);
      await closeVaultMatter(token, matterId).catch(() => undefined);
      throw new Error(`Vault export ${exportId} failed`);
    }
    if (attempt < MAX_POLL_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  if (exportFiles.length === 0) {
    console.error('[vault-export] timed out waiting for export to complete');
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
    if (!file.objectName.endsWith('.zip')) {
      debug(`skipping non-zip file: ${file.objectName}`);
      continue;
    }

    log(`downloading ${file.objectName} (${file.size} bytes)`);
    let zipBuffer: Buffer;
    try {
      zipBuffer = await downloadExportFile(token, file);
    } catch (err) {
      console.error(`[vault-export] failed to download ${file.objectName}:`, err);
      throw err;
    }

    filesDownloaded++;
    debug(`downloaded ${file.objectName}: ${zipBuffer.length} bytes`);

    // Extract MBOX entries from the zip
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      console.error(`[vault-export] failed to open zip ${file.objectName}:`, err);
      throw err;
    }

    const mboxEntries = zip.getEntries().filter((e) => e.entryName.endsWith('.mbox'));
    log(`${file.objectName}: ${mboxEntries.length} MBOX entries inside zip`);

    for (const entry of mboxEntries) {
      const mboxContent = entry.getData().toString('utf-8');
      debug(`extracted ${entry.entryName}: ${mboxContent.length} chars`);

      // Save extracted MBOX to /tmp for local inspection
      if (process.env.NODE_ENV === 'development') {
        const tmpName = `vault-${deps.job.id}-${path.basename(entry.entryName)}`;
        const tmpPath = path.join('/tmp', tmpName);
        try {
          await fs.writeFile(tmpPath, mboxContent, 'utf-8');
          debug(`saved MBOX to ${tmpPath}`);
        } catch (err) {
          console.error(`[vault-export] failed to save MBOX to ${tmpPath}:`, err);
        }
      }

      const parsed = parseMboxContent(mboxContent);
      const classified = classifyEmails(parsed, custodianSet);
      emailsParsed += parsed.length;
      debug(`${entry.entryName}: parsed ${parsed.length} emails, ${classified.length} classified`);

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
  }

  await closeVaultMatter(token, matterId).catch((err) => {
    console.error('[vault-export] failed to close matter (non-fatal):', err);
  });

  const result: VaultExportResult = {
    matters_created: 1,
    files_downloaded: filesDownloaded,
    emails_parsed: emailsParsed,
    contacts_created: contactsCreated,
    messages_added: messagesAdded,
  };
  log(`done: ${JSON.stringify(result)}`);
  return result;
}
