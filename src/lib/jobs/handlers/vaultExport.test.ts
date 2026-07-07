import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runVaultExport } from './vaultExport';

const mocks = vi.hoisted(() => ({
  loadVaultCredentials: vi.fn(() => ({
    client_email: 'svc@proj.iam.gserviceaccount.com',
    private_key: '-----PEM-----',
    project_id: 'proj',
  })),
  getVaultAccessToken: vi.fn().mockResolvedValue('token-xyz'),
  createVaultMatter: vi.fn().mockResolvedValue('matter-1'),
  createVaultExport: vi.fn().mockResolvedValue('export-1'),
  pollVaultExport: vi.fn(),
  downloadExportFile: vi.fn(),
  closeVaultMatter: vi.fn().mockResolvedValue(undefined),
  findSyncedCustodianEmails: vi.fn(),
  getActiveWorkspaceId: vi.fn().mockResolvedValue('ws-1'),
}));

vi.mock('@/lib/services/googleVaultService', () => ({
  loadVaultCredentials: mocks.loadVaultCredentials,
  getVaultAccessToken: mocks.getVaultAccessToken,
  createVaultMatter: mocks.createVaultMatter,
  createVaultExport: mocks.createVaultExport,
  pollVaultExport: mocks.pollVaultExport,
  downloadExportFile: mocks.downloadExportFile,
  closeVaultMatter: mocks.closeVaultMatter,
  parseMboxContent: vi.fn(),
  classifyEmails: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: class {},
  EmployerRepository: class {},
  EmployerCurationRepository: class {},
  EmployerRelatedCompanyRepository: class {},
  CorrespondentRepository: class {},
  CorrespondentCurationRepository: class {},
  EmployerNoteRepository: class {},
  TopicRepository: class {},
  EmailRepository: class {},
  EmployerTeamRepository: class {},
  WorkspaceCorrespondentRepository: class {},
  UserWorkspaceRepository: class {
    findSyncedCustodianEmails = mocks.findSyncedCustodianEmails;
  },
}));

vi.mock('@/lib/services/crmService', () => ({
  CRMService: class {},
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: mocks.getActiveWorkspaceId,
}));

describe('runVaultExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits without calling Vault when no mailbox is synced and no explicit list is given', async () => {
    mocks.findSyncedCustodianEmails.mockResolvedValueOnce([]);

    const result = await runVaultExport(
      {},
      { db: {} as never, job: { id: 'job-1', workspace_id: 'ws-1' } as never },
    );

    expect(result).toEqual({
      matters_created: 0,
      files_downloaded: 0,
      emails_parsed: 0,
      employers_created: 0,
      emails_added: 0,
    });
    expect(mocks.createVaultMatter).not.toHaveBeenCalled();
  });

  it('resolves custodians from user_workspaces.is_email_synced when the payload omits an explicit list', async () => {
    mocks.findSyncedCustodianEmails.mockResolvedValueOnce(['synced@x.com']);
    mocks.pollVaultExport.mockResolvedValueOnce({
      id: 'export-1',
      status: 'COMPLETED',
      files: [{ bucketName: 'gcs-bkt', objectName: 'manifest.json', size: '1' }],
    });

    await runVaultExport({}, { db: {} as never, job: { id: 'job-1', workspace_id: 'ws-1' } as never });

    expect(mocks.findSyncedCustodianEmails).toHaveBeenCalledTimes(1);
    expect(mocks.createVaultExport).toHaveBeenCalledWith(
      'token-xyz',
      'matter-1',
      ['synced@x.com'],
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('an explicit payload.custodianEmails overrides the dynamic lookup entirely', async () => {
    mocks.pollVaultExport.mockResolvedValueOnce({
      id: 'export-1',
      status: 'COMPLETED',
      files: [{ bucketName: 'gcs-bkt', objectName: 'manifest.json', size: '1' }],
    });

    await runVaultExport(
      { custodianEmails: ['explicit@x.com'] },
      { db: {} as never, job: { id: 'job-1', workspace_id: 'ws-1' } as never },
    );

    expect(mocks.findSyncedCustodianEmails).not.toHaveBeenCalled();
    expect(mocks.createVaultExport).toHaveBeenCalledWith(
      'token-xyz',
      'matter-1',
      ['explicit@x.com'],
      expect.any(Date),
      expect.any(Date),
    );
  });
});
