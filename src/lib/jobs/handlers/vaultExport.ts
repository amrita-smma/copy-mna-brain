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
  VAULT_CUSTODIAN_EMAILS,
} from '@/lib/services/googleVaultService';
import {
  EmployerRepository,
  EmployerCurationRepository,
  CorrespondentRepository,
  CorrespondentCurationRepository,
  EmployerNoteRepository,
  TopicRepository,
  EmailRepository,
  EmployerTeamRepository,
} from '@/lib/repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { CRMService } from '@/lib/services/crmService';

export const VAULT_EXPORT_TIMEOUT_SECONDS = 1800; // 30 minutes

/**
 * Expected cadence between scheduled Vault syncs. Surfaced in the CRM insights
 * bar as "next sync in …". The actual job is dispatched manually today; this
 * constant just feeds the UX hint.
 */
export const VAULT_SYNC_CADENCE_MS = 24 * 60 * 60 * 1000;

export { VAULT_CUSTODIAN_EMAILS };

export interface VaultExportPayload {
  custodianEmails?: string[];
  daysBack?: number;
}

export interface VaultExportResult {
  matters_created: number;
  files_downloaded: number;
  emails_parsed: number;
  employers_created: number;
  emails_added: number;
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
  const crmService = new CRMService(
    new EmployerRepository(deps.db),
    new CorrespondentRepository(deps.db),
    new EmployerNoteRepository(deps.db),
    new TopicRepository(deps.db),
    new EmailRepository(deps.db),
    new EmployerTeamRepository(deps.db),
    new EmployerCurationRepository(deps.db),
    new CorrespondentCurationRepository(deps.db),
  );

  let filesDownloaded = 0;
  let emailsParsed = 0;
  let totalEmployersCreated = 0;
  let totalEmailsAdded = 0;

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

      const { employers_created, emails_added } = await crmService.ingestEmails(
        classified.map((msg) => ({
          from_email: msg.from_email ?? msg.contact_email,
          from_name: msg.contact_name,
          to_email: msg.to_email,
          subject: msg.subject,
          body: msg.body,
          sent_at: msg.sent_at,
          direction: msg.direction,
        })),
      );
      totalEmployersCreated += employers_created;
      totalEmailsAdded += emails_added;
    }
  }

  await closeVaultMatter(token, matterId).catch((err) => {
    console.error('[vault-export] failed to close matter (non-fatal):', err);
  });

  const result: VaultExportResult = {
    matters_created: 1,
    files_downloaded: filesDownloaded,
    emails_parsed: emailsParsed,
    employers_created: totalEmployersCreated,
    emails_added: totalEmailsAdded,
  };
  log(`done: ${JSON.stringify(result)}`);
  return result;
}
