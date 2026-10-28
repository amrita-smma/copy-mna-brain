import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InsightService,
  InsightNotFoundError,
  InsightValidationError,
  InsightEvidenceMarkerError,
  InsightPayloadTooLargeError,
  StaleInsightVersionError,
  InsightRunPublishError,
  UNCHANGED_REFRESH_LABEL,
} from './insightService';
import { insightContentHash } from '@/lib/insights/contentHash';
import type { Insight, InsightListFilter } from '@/lib/repositories/insightRepository';
import type { InsightVersion } from '@/lib/repositories/insightVersionRepository';
import type {
  InsightRunDraft,
  UpsertInsightRunDraftInput,
} from '@/lib/repositories/insightRunDraftRepository';
import type { DbClient } from '@/lib/repositories/types';
import { MAX_INSIGHT_BYTES } from '@/lib/insights/srcdoc';
import { TOO_DEEPLY_NESTED_MESSAGE } from '@/lib/insights/parseHtml';
import { createSectorRegistry } from '@/lib/agents/sector/registry';
import {
  sourceRefHtml,
  sourcesSectionHtml,
} from '@/lib/agents/sector/evidenceMarkers';
import type { SectorAgentEntry } from '@/lib/agents/sector/types';

const WS = 'ws-1';

class MockInsightRepository {
  insights: Insight[] = [];
  lockCalls: { id: string; workspaceId: string }[] = [];
  callLog: string[] = [];

  private live(workspaceId: string) {
    return this.insights.filter((a) => a.workspace_id === workspaceId && a.archived_at === null);
  }
  async findByWorkspaceId(workspaceId: string) {
    this.callLog.push('repo.findByWorkspaceId');
    return this.live(workspaceId);
  }
  listFilters: InsightListFilter[] = [];
  private matching(workspaceId: string, filter: InsightListFilter) {
    this.listFilters.push(filter);
    return this.insights
      .filter((a) => a.workspace_id === workspaceId)
      .filter((a) => (filter.archived ? a.archived_at !== null : a.archived_at === null))
      .filter((a) => filter.createdBy === undefined || a.created_by === filter.createdBy)
      .filter(
        (a) =>
          filter.agentKey === undefined ||
          (a.agent_key ?? null) === filter.agentKey,
      )
      .filter((a) => !filter.q || a.name.toLowerCase().includes(filter.q.toLowerCase()));
  }
  async findPageWithCreator(
    workspaceId: string,
    filter: InsightListFilter,
    page: { limit: number; offset: number },
  ) {
    this.callLog.push('repo.findPageWithCreator');
    return this.matching(workspaceId, filter)
      .slice(page.offset, page.offset + page.limit)
      .map((a) => ({
        ...a,
        created_by_name: a.created_by ? `User ${a.created_by}` : null,
      }));
  }
  async countByFilter(workspaceId: string, filter: InsightListFilter) {
    this.callLog.push('repo.countByFilter');
    return this.matching(workspaceId, filter).length;
  }
  async unarchive(id: string, workspaceId: string) {
    this.callLog.push('repo.unarchive');
    const existing = this.insights.find((a) => a.id === id && a.workspace_id === workspaceId);
    if (!existing || existing.archived_at === null) return undefined;
    return this.update(id, workspaceId, { archived_at: null, is_featured: false });
  }
  async findById(id: string, workspaceId: string): Promise<Insight | undefined> {
    this.callLog.push('repo.findById');
    return this.insights.find((a) => a.id === id && a.workspace_id === workspaceId);
  }
  async lockById(id: string, workspaceId: string, _executor?: unknown) {
    this.callLog.push('repo.lockById');
    this.lockCalls.push({ id, workspaceId });
    return this.findById(id, workspaceId);
  }
  async create(input: any): Promise<Insight> {
    this.callLog.push('repo.create');
    const now = new Date().toISOString();
    const created: Insight = {
      id: `art-${this.insights.length + 1}`,
      workspace_id: input.workspace_id,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind ?? 'document',
      is_featured: input.is_featured ?? false,
      created_by: input.created_by ?? null,
      updated_by: input.updated_by ?? null,
      created_at: now,
      updated_at: now,
      archived_at: null,
      agent_key: input.agent_key ?? null,
      source_template_id: input.source_template_id ?? null,
    };
    this.insights.push(created);
    return created;
  }
  async update(id: string, workspaceId: string, patch: any): Promise<Insight | undefined> {
    this.callLog.push('repo.update');
    const idx = this.insights.findIndex((a) => a.id === id && a.workspace_id === workspaceId);
    if (idx === -1) return undefined;
    this.insights[idx] = { ...this.insights[idx], ...patch, updated_at: new Date().toISOString() };
    return this.insights[idx];
  }
  async archive(id: string, workspaceId: string) {
    this.callLog.push('repo.archive');
    return this.update(id, workspaceId, { archived_at: new Date().toISOString() });
  }
  async hardDelete(workspaceId: string, id: string): Promise<boolean> {
    this.callLog.push('repo.hardDelete');
    const idx = this.insights.findIndex((a) => a.id === id && a.workspace_id === workspaceId);
    if (idx === -1) return false;
    this.insights.splice(idx, 1);
    return true;
  }
  async clearFeatured(workspaceId: string): Promise<void> {
    this.callLog.push('repo.clearFeatured');
    for (const a of this.insights) if (a.workspace_id === workspaceId) a.is_featured = false;
  }
}

class MockInsightVersionRepository {
  versions: InsightVersion[] = [];
  callLog: string[] = [];
  latestBySourceRunIdCalls: { runId: string; workspaceId: string }[] = [];

  private ofInsight(insightId: string, workspaceId: string) {
    return this.versions
      .filter((v) => v.insight_id === insightId && v.workspace_id === workspaceId)
      .sort((a, b) => b.version_no - a.version_no);
  }
  async findCurrent(insightId: string, workspaceId: string) {
    this.callLog.push('versionRepo.findCurrent');
    const current = this.ofInsight(insightId, workspaceId)[0];
    return current ? { version_no: current.version_no, content_hash: current.content_hash } : undefined;
  }
  async findCurrentHead(insightId: string, workspaceId: string) {
    this.callLog.push('versionRepo.findCurrentHead');
    const c = this.ofInsight(insightId, workspaceId)[0];
    return c ? { id: c.id, version_no: c.version_no, created_at: c.created_at, trigger: c.trigger } : undefined;
  }
  async findByInsightId(insightId: string, workspaceId: string) {
    this.callLog.push('versionRepo.findByInsightId');
    return this.ofInsight(insightId, workspaceId).map(
      ({ html: _h, workspace_id: _w, insight_id: _i, content_hash: _c, ...summary }) => summary,
    );
  }
  async findByVersionNo(insightId: string, workspaceId: string, versionNo: number) {
    this.callLog.push('versionRepo.findByVersionNo');
    return this.ofInsight(insightId, workspaceId).find((v) => v.version_no === versionNo);
  }
  async findLatestVersionNosByInsightIds(insightIds: string[], workspaceId: string) {
    this.callLog.push('versionRepo.findLatestVersionNosByInsightIds');
    const map = new Map<string, number>();
    for (const id of insightIds) {
      const current = this.ofInsight(id, workspaceId)[0];
      if (current) map.set(id, current.version_no);
    }
    return map;
  }
  async findRoutineVersionBySourceRunId(runId: string, workspaceId: string) {
    this.callLog.push('versionRepo.findRoutineVersionBySourceRunId');
    const v = this.versions.find(
      (x) => x.workspace_id === workspaceId && x.source_run_id === runId && x.trigger === 'routine',
    );
    return v ? { id: v.id, version_no: v.version_no, insight_id: v.insight_id } : undefined;
  }
  async findLatestBySourceRunId(runId: string, workspaceId: string) {
    this.latestBySourceRunIdCalls.push({ runId, workspaceId });
    const v = this.versions.find((x) => x.source_run_id === runId && x.workspace_id === workspaceId);
    return v
      ? { insight_id: v.insight_id, insight_name: 'Name', version_no: v.version_no, is_unchanged: v.is_unchanged }
      : undefined;
  }
  async create(input: any): Promise<InsightVersion> {
    this.callLog.push('versionRepo.create');
    const created: InsightVersion = {
      id: `v-${this.versions.length + 1}`,
      workspace_id: input.workspace_id,
      insight_id: input.insight_id,
      version_no: input.version_no,
      html: input.html,
      trigger: input.trigger,
      label: input.label ?? null,
      created_by: input.created_by ?? null,
      created_at: new Date().toISOString(),
      source_run_id: input.source_run_id ?? null,
      content_hash: input.content_hash ?? null,
      is_unchanged: input.is_unchanged ?? false,
      agent_key: input.agent_key ?? null,
    };
    this.versions.push(created);
    return created;
  }
}

class MockInsightRunDraftRepository {
  drafts: InsightRunDraft[] = [];
  callLog: string[] = [];

  async findByRunId(runId: string, workspaceId: string): Promise<InsightRunDraft | undefined> {
    this.callLog.push('draftRepo.findByRunId');
    return this.drafts.find((d) => d.run_id === runId && d.workspace_id === workspaceId);
  }
  async upsert(input: UpsertInsightRunDraftInput): Promise<InsightRunDraft> {
    this.callLog.push('draftRepo.upsert');
    const now = new Date().toISOString();
    const idx = this.drafts.findIndex((d) => d.run_id === input.run_id);
    if (idx >= 0) {
      this.drafts[idx] = { ...this.drafts[idx], html: input.html, updated_at: now };
      return this.drafts[idx];
    }
    const created: InsightRunDraft = { ...input, created_at: now, updated_at: now };
    this.drafts.push(created);
    return created;
  }
  async deleteByRunId(runId: string, workspaceId: string): Promise<void> {
    this.callLog.push('draftRepo.deleteByRunId');
    const idx = this.drafts.findIndex((d) => d.run_id === runId && d.workspace_id === workspaceId);
    if (idx >= 0) this.drafts.splice(idx, 1);
  }
}

type CreateInput = Parameters<InsightService['createFromDocument']>[0];
type PublishInput = Parameters<InsightService['publishVersion']>[0];
type DraftEdit = Parameters<InsightService['applyRunDraftEdit']>[0]['edit'];

const section = (name: string, body: string) => `<section data-section="${name}">${body}</section>`;

describe('InsightService', () => {
  let insightRepo: MockInsightRepository;
  let versionRepo: MockInsightVersionRepository;
  let draftRepo: MockInsightRunDraftRepository;
  let service: InsightService;
  let mockDb: any;

  const makeService = (...extra: [registry?: any, routines?: any]) =>
    new InsightService(
      insightRepo as unknown as any,
      versionRepo as unknown as any,
      draftRepo as unknown as any,
      mockDb as unknown as DbClient,
      ...extra,
    );
  const create = (over: Partial<CreateInput> = {}, svc: InsightService = service) =>
    svc.createFromDocument({ workspaceId: WS, name: 'Doc', html: '<p>v1</p>', ...over });
  const publish = (insightId: string, html: string, extra: Partial<PublishInput> = {}) =>
    service.publishVersion({ workspaceId: WS, insightId, html, ...extra });
  const seedDraft = (runId: string, insightId: string, html: string, base = 1) =>
    draftRepo.upsert({ run_id: runId, workspace_id: WS, insight_id: insightId, base_version_no: base, html });
  const editDraft = (runId: string, insightId: string, edit: DraftEdit, svc: InsightService = service) =>
    svc.applyRunDraftEdit({ workspaceId: WS, runId, insightId, edit });
  const version = (insightId: string, no: number) =>
    versionRepo.versions.find((v) => v.insight_id === insightId && v.version_no === no)!;
  const row = (id: string) => insightRepo.insights.find((a) => a.id === id)!;

  beforeEach(() => {
    insightRepo = new MockInsightRepository();
    versionRepo = new MockInsightVersionRepository();
    draftRepo = new MockInsightRunDraftRepository();
    mockDb = { transaction: vi.fn(async (callback) => callback(mockDb)) };
    service = makeService();
  });

  describe('InsightService.list', () => {
    const routine = (insightId: string, over: Record<string, unknown> = {}) => ({
      id: `rt-${insightId}`,
      insight_id: insightId,
      enabled: true,
      paused_reason: null,
      ...over,
    });
    const withRoutines = (rows: unknown[]) => {
      const routines = {
        findActiveByInsightId: vi.fn(),
        findActiveByInsightIds: vi.fn().mockResolvedValue(rows),
        resumeFromAgentPause: vi.fn(),
      };
      return { svc: makeService(undefined, routines), routines };
    };

    it('returns an empty page without further reads when no insights exist', async () => {
      const { svc, routines } = withRoutines([]);
      expect(await svc.list(WS)).toEqual({ items: [], total: 0 });
      expect(versionRepo.callLog).not.toContain('versionRepo.findLatestVersionNosByInsightIds');
      expect(routines.findActiveByInsightIds).not.toHaveBeenCalled();
    });

    it('returns non-archived insights with latest_version_no, created_by_name and the total', async () => {
      await create({ name: 'Report 1', userId: 'u-1' });
      await create({ name: 'Report 2' });
      await service.archive(WS, 'art-2');

      const { items, total } = await service.list(WS);
      expect(total).toBe(1);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 'art-1',
        name: 'Report 1',
        latest_version_no: 1,
        created_by_name: 'User u-1',
        source_template_id: null,
      });
    });

    it('passes the search and filters to the repository, and the page window', async () => {
      await create({ name: 'A' });
      await create({ name: 'B' });
      await create({ name: 'C' });
      const pageSpy = vi.spyOn(insightRepo, 'findPageWithCreator');

      const { items, total } = await service.list(WS, {
        q: 'x',
        agentKey: null,
        archived: false,
        limit: 2,
        offset: 1,
      });

      expect(pageSpy).toHaveBeenCalledWith(
        WS,
        { q: 'x', agentKey: null, archived: false },
        { limit: 2, offset: 1 },
      );
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });

    it('pages with offset and limit, defaulting to 50 rows from the start', async () => {
      for (const name of ['A', 'B', 'C']) await create({ name });
      const pageSpy = vi.spyOn(insightRepo, 'findPageWithCreator');

      const page = await service.list(WS, { limit: 2, offset: 2 });
      expect(page.items.map((i) => i.id)).toEqual(['art-3']);
      expect(page.total).toBe(3);

      await service.list(WS);
      expect(pageSpy).toHaveBeenLastCalledWith(WS, expect.anything(), { limit: 50, offset: 0 });
    });

    it('lists archived insights with archived', async () => {
      await create({ name: 'Live' });
      await create({ name: 'Gone' });
      await service.archive(WS, 'art-2');

      const { items, total } = await service.list(WS, { archived: true });
      expect(items.map((i) => i.id)).toEqual(['art-2']);
      expect(total).toBe(1);
    });

    it("mine keeps the user's own insights", async () => {
      await create({ name: 'Mine', userId: 'u-1' });
      await create({ name: 'Theirs', userId: 'u-2' });

      const { items } = await service.list(WS, { mine: true, userId: 'u-1' });
      expect(items.map((i) => i.id)).toEqual(['art-1']);
      expect(insightRepo.listFilters.at(-1)).toMatchObject({ createdBy: 'u-1' });
    });

    it('mine without a user matches nothing rather than every insight', async () => {
      await create({ name: 'Mine', userId: 'u-1' });

      expect(await service.list(WS, { mine: true, userId: null })).toEqual({ items: [], total: 0 });
      expect(insightRepo.callLog).not.toContain('repo.findPageWithCreator');
    });

    it('reads the refresh routines of N insights in exactly one call, and maps each row\'s status', async () => {
      await create({ name: 'Scheduled' });
      await create({ name: 'Paused' });
      await create({ name: 'Unscheduled' });
      const { svc, routines } = withRoutines([
        routine('art-1'),
        routine('art-2', { enabled: false, paused_reason: 'agent_deprecated' }),
      ]);

      const { items } = await svc.list(WS);

      expect(routines.findActiveByInsightIds).toHaveBeenCalledTimes(1);
      expect(routines.findActiveByInsightIds).toHaveBeenCalledWith(['art-1', 'art-2', 'art-3']);
      expect(routines.findActiveByInsightId).not.toHaveBeenCalled();
      const byId = new Map(items.map((i) => [i.id, i.refresh]));
      expect(byId.get('art-1')).toEqual({ enabled: true, paused_reason: null });
      expect(byId.get('art-2')).toEqual({ enabled: false, paused_reason: 'agent_deprecated' });
      expect(byId.get('art-3')).toBeNull();
    });

    it('reads the latest version numbers in one batched call', async () => {
      await create({ name: 'A' });
      await create({ name: 'B' });
      versionRepo.callLog = [];

      await service.list(WS);

      expect(
        versionRepo.callLog.filter((c) => c === 'versionRepo.findLatestVersionNosByInsightIds'),
      ).toHaveLength(1);
      expect(versionRepo.callLog).not.toContain('versionRepo.findCurrent');
    });

    it('gives every row a null refresh when no routines repository is wired', async () => {
      await create({ name: 'A' });
      const { items } = await service.list(WS);
      expect(items[0].refresh).toBeNull();
    });
  });

  describe('InsightService.get', () => {
    it('returns latest version by default', async () => {
      const created = await create();
      await publish(created.id, '<p>v2</p>', { baseVersionNo: 1 });

      const detail = await service.get(WS, created.id);
      expect(detail).toMatchObject({ id: created.id, version_no: 2, latest_version_no: 2, html: '<p>v2</p>' });
      expect(detail.versions).toHaveLength(2);
    });

    it('returns specific version when versionNo is specified', async () => {
      const created = await create();
      await publish(created.id, '<p>v2</p>', { baseVersionNo: 1 });

      const detail = await service.get(WS, created.id, 1);
      expect(detail).toMatchObject({ version_no: 1, latest_version_no: 2, html: '<p>v1</p>' });
    });

    it('throws InsightNotFoundError when insight does not exist', async () => {
      await expect(service.get(WS, 'nonexistent')).rejects.toThrow(InsightNotFoundError);
    });

    it('throws InsightNotFoundError when requested version does not exist', async () => {
      const created = await create();
      await expect(service.get(WS, created.id, 99)).rejects.toThrow(InsightNotFoundError);
      await expect(service.get(WS, created.id, 99)).rejects.toThrow(
        `Version 99 for insight "${created.id}" not found`,
      );
    });
  });

  describe('InsightService.exists', () => {
    it('returns true for a live insight in the workspace', async () => {
      const created = await create();
      await expect(service.exists(WS, created.id)).resolves.toBe(true);
    });

    it('returns false for a missing insight', async () => {
      await expect(service.exists(WS, 'nonexistent')).resolves.toBe(false);
    });

    it('returns false for an insight in another workspace', async () => {
      const created = await create();
      await expect(service.exists('other-workspace', created.id)).resolves.toBe(false);
    });

    it('returns false for an archived insight, matching get()', async () => {
      const created = await create();
      row(created.id).archived_at = new Date().toISOString() as never;
      await expect(service.exists(WS, created.id)).resolves.toBe(false);
    });
  });

  describe('InsightService.createFromDocument', () => {
    it('creates an insight and version 1 in one transaction', async () => {
      const detail = await create({
        name: 'Quarterly Review',
        description: 'Q3 review',
        html: '<div>Hello World</div>',
        userId: 'user-1',
      });

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(detail).toMatchObject({
        name: 'Quarterly Review',
        description: 'Q3 review',
        kind: 'document',
        latest_version_no: 1,
        version_no: 1,
        html: '<div>Hello World</div>',
      });
      expect(detail.versions).toHaveLength(1);
      expect(detail.versions[0].trigger).toBe('copilot_create');
    });

    it('stamps the creating workforce run on version 1, and leaves it null otherwise', async () => {
      const fromRun = await create({ sourceRunId: 'run-9' });
      expect(version(fromRun.id, 1).source_run_id).toBe('run-9');

      const fromChat = await create();
      expect(version(fromChat.id, 1).source_run_id).toBeNull();
    });

    it('creates an insight with kind report when specified', async () => {
      expect((await create({ kind: 'report' })).kind).toBe('report');
    });

    it('rejects an invalid kind', async () => {
      await expect(create({ kind: 'invalid' as any })).rejects.toThrow(InsightValidationError);
    });

    it('stores HTML verbatim without sanitization', async () => {
      const scriptHtml = '<script>alert("test")</script><div style="color:red">Body</div>';
      expect((await create({ html: scriptHtml })).html).toBe(scriptHtml);
    });

    it.each([
      ['empty name', '   '],
      ['name exceeding 120 characters', 'a'.repeat(121)],
    ])('rejects %s', async (_label, name) => {
      await expect(create({ name })).rejects.toThrow(InsightValidationError);
    });

    it('rejects html exceeding MAX_INSIGHT_BYTES', async () => {
      await expect(create({ html: 'x'.repeat(MAX_INSIGHT_BYTES + 10) })).rejects.toThrow(
        InsightPayloadTooLargeError,
      );
    });

    it('rejects html nested too deeply for the chat outline to walk', async () => {
      await expect(create({ html: '<span>x'.repeat(1_000) })).rejects.toThrow(TOO_DEEPLY_NESTED_MESSAGE);
    });
  });

  describe('InsightService.uploadDocument', () => {
    const upload = (over: Partial<Parameters<InsightService['uploadDocument']>[0]> = {}) =>
      service.uploadDocument({
        workspaceId: WS,
        fileName: 'Q3 review.html',
        html: '<!DOCTYPE html><html><head><title>Q3 Review</title></head><body><p>x</p></body></html>',
        ...over,
      });
    const refusal = (over: Parameters<typeof upload>[0]) =>
      upload(over).then(
        () => { throw new Error('expected the upload to be refused'); },
        (e: unknown) => e as Error,
      );

    it('creates a document insight whose version 1 has trigger upload, stored verbatim', async () => {
      const html = '<html><body><script>draw()</script><p>chart</p></body></html>';
      const detail = await upload({ html, name: 'Board pack', description: 'For the board', userId: 'user-1' });

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(detail).toMatchObject({
        name: 'Board pack',
        description: 'For the board',
        kind: 'document',
        version_no: 1,
        html,
        source_template_name: null,
      });
      expect(detail.versions[0].trigger).toBe('upload');
      expect(versionRepo.versions[0]).toMatchObject({
        trigger: 'upload',
        created_by: 'user-1',
        agent_key: null,
        content_hash: insightContentHash(html),
      });
      expect(row(detail.id).source_template_id).toBeNull();
    });

    it.each([
      ['no name', undefined],
      ['a blank name', '   '],
    ])('names the insight after the document <title> when given %s', async (_label, name) => {
      expect((await upload({ name })).name).toBe('Q3 Review');
    });

    it('falls back to the file name without its extension when there is no <title>', async () => {
      expect((await upload({ html: '<p>x</p>', name: null })).name).toBe('Q3 review');
    });

    it.each([
      ['a non-HTML file', { fileName: 'notes.txt' }, /Only HTML files/],
      ['an empty file', { html: '  \n ' }, /The file is empty/],
    ])('refuses %s without writing anything', async (_label, over, message) => {
      await expect(upload(over)).rejects.toThrow(InsightValidationError);
      await expect(upload(over)).rejects.toThrow(message);
      expect(insightRepo.insights).toHaveLength(0);
    });

    it('refuses a file over the size cap with a size the person can read', async () => {
      const html = '<p>' + 'x'.repeat(MAX_INSIGHT_BYTES) + '</p>';
      await expect(upload({ html })).rejects.toThrow(InsightPayloadTooLargeError);
      await expect(upload({ html })).rejects.toThrow(/insights are limited to 4 MB/);
    });

    it('refuses malformed source markers in words for the uploader, not the model', async () => {
      const html = '<p><span data-source-ref="first">a</span><span data-source-ref="second">b</span></p>';
      const err = await refusal({ html });

      expect(err).toBeInstanceOf(InsightValidationError);
      expect(err).not.toBeInstanceOf(InsightEvidenceMarkerError);
      expect(err.message).toMatch(/^This file has 2 source markers that can't be read, so it wasn't saved:/);
      expect(err.message).toContain('data-source-ref must name a source id');
      expect(err.message).toContain('then upload it again.');
      expect(err.message).not.toContain('the part you changed');
      expect(insightRepo.insights).toHaveLength(0);
    });

    it('refuses a document nested too deeply to outline, before writing anything', async () => {
      const err = await refusal({ html: '<div>'.repeat(1_000) });
      expect(err).toBeInstanceOf(InsightValidationError);
      expect(err.message).toBe(TOO_DEEPLY_NESTED_MESSAGE);
      expect(insightRepo.insights).toHaveLength(0);
    });

    it('refuses an unterminated tag too long to scan, without throwing a RangeError', async () => {
      const err = await refusal({ html: '<a ' + 'b=c '.repeat(1_048_000) });
      expect(err).toBeInstanceOf(InsightValidationError);
      expect(err.message).toMatch(/too long to read/);
    });

    it('lists at most five marker problems and summarises the rest', async () => {
      const html = Array.from({ length: 7 }, (_, i) => `<span data-source-ref="bad${i}">x</span>`).join('');
      const err = await refusal({ html });
      expect(err.message.split('\n').filter((l) => l.startsWith('- <'))).toHaveLength(5);
      expect(err.message).toContain('- …and 2 more.');
    });
  });

  describe('InsightService.publishVersion', () => {
    it('appends a version with trigger copilot_edit', async () => {
      const created = await create();

      const updated = await publish(created.id, '<p>v2 edited</p>', {
        label: 'Updated numbers',
        baseVersionNo: 1,
      });

      expect(updated).toMatchObject({ version_no: 2, latest_version_no: 2, html: '<p>v2 edited</p>' });
      expect(updated.versions).toHaveLength(2);
      expect(updated.versions[0]).toMatchObject({ trigger: 'copilot_edit', label: 'Updated numbers' });
      expect(versionRepo.versions[1].source_run_id).toBeNull();
    });

    it('regression: locks parent row before reading current and inserting version', async () => {
      const created = await create();
      const lock = vi.spyOn(insightRepo, 'lockById');
      const findCurrent = vi.spyOn(versionRepo, 'findCurrent');
      const insert = vi.spyOn(versionRepo, 'create');

      await publish(created.id, '<p>v2</p>', { baseVersionNo: 1 });

      expect(insightRepo.lockCalls).toEqual([{ id: created.id, workspaceId: WS }]);
      const [lockedAt] = lock.mock.invocationCallOrder;
      const [readAt] = findCurrent.mock.invocationCallOrder;
      const [insertedAt] = insert.mock.invocationCallOrder;
      expect(lockedAt).toBeLessThan(readAt);
      expect(readAt).toBeLessThan(insertedAt);
    });

    it('regression: throws StaleInsightVersionError when baseVersionNo is stale', async () => {
      const created = await create();
      await publish(created.id, '<p>v2</p>', { baseVersionNo: 1 });

      await expect(publish(created.id, '<p>v3 concurrent</p>', { baseVersionNo: 1 })).rejects.toThrow(
        StaleInsightVersionError,
      );
      expect((await versionRepo.findCurrent(created.id, WS))?.version_no).toBe(2);
    });

    it('rejects html exceeding MAX_INSIGHT_BYTES', async () => {
      const created = await create();
      await expect(
        publish(created.id, 'y'.repeat(MAX_INSIGHT_BYTES + 1), { baseVersionNo: 1 }),
      ).rejects.toThrow(InsightPayloadTooLargeError);
    });

    it('passes trigger workforce and sourceRunId to version repo create', async () => {
      const created = await create();

      await publish(created.id, '<p>v2 workforce</p>', {
        baseVersionNo: 1,
        trigger: 'workforce',
        sourceRunId: 'run-wf-1',
      });

      expect(versionRepo.versions[1]).toMatchObject({ trigger: 'workforce', source_run_id: 'run-wf-1' });
    });
  });

  describe('InsightService.rollback', () => {
    it('appends a new version with target HTML and trigger rollback', async () => {
      const created = await create({ html: '<p>Original v1</p>' });
      await publish(created.id, '<p>Bad v2</p>', { baseVersionNo: 1 });

      const rolledBack = await service.rollback({ workspaceId: WS, insightId: created.id, toVersionNo: 1 });

      expect(rolledBack).toMatchObject({ version_no: 3, latest_version_no: 3, html: '<p>Original v1</p>' });
      expect(rolledBack.versions[0].trigger).toBe('rollback');
      expect(rolledBack.versions).toHaveLength(3);
    });

    it('regression: locks parent row before allocating version', async () => {
      const created = await create();
      insightRepo.lockCalls = [];

      await service.rollback({ workspaceId: WS, insightId: created.id, toVersionNo: 1 });

      expect(insightRepo.lockCalls).toEqual([{ id: created.id, workspaceId: WS }]);
    });

    it('throws InsightNotFoundError if target version does not exist', async () => {
      const created = await create();
      await expect(
        service.rollback({ workspaceId: WS, insightId: created.id, toVersionNo: 999 }),
      ).rejects.toThrow(InsightNotFoundError);
    });
  });

  describe('InsightService.rename', () => {
    it('updates name and returns updated summary', async () => {
      const created = await create({ name: 'Old Name' });
      expect(await service.rename(WS, created.id, 'New Name')).toMatchObject({
        id: created.id,
        name: 'New Name',
      });
    });

    it('throws InsightValidationError on empty name', async () => {
      const created = await create();
      await expect(service.rename(WS, created.id, '   ')).rejects.toThrow(InsightValidationError);
    });
  });

  describe('InsightService.setFeatured', () => {
    it('sets is_featured and clears previous featured insight', async () => {
      const art1 = await create({ name: 'First' });
      const art2 = await create({ name: 'Second' });

      await service.setFeatured(WS, art1.id, true);
      expect(row(art1.id).is_featured).toBe(true);

      await service.setFeatured(WS, art2.id, true);
      expect(row(art1.id).is_featured).toBe(false);
      expect(row(art2.id).is_featured).toBe(true);
    });

    it('unfeatures an insight', async () => {
      const art = await create();
      await service.setFeatured(WS, art.id, true);
      expect((await service.setFeatured(WS, art.id, false)).is_featured).toBe(false);
    });
  });

  describe('InsightService.archive', () => {
    it('archives insight so it is excluded from list', async () => {
      const art = await create();
      await service.archive(WS, art.id);
      expect((await service.list(WS)).items.find((a) => a.id === art.id)).toBeUndefined();
    });
  });

  describe('InsightService.restore', () => {
    it('brings an archived insight back to the live list', async () => {
      const art = await create();
      await service.archive(WS, art.id);

      const restored = await service.restore(WS, art.id);

      expect(restored).toMatchObject({ id: art.id, latest_version_no: 1 });
      expect(row(art.id).archived_at).toBeNull();
      expect((await service.list(WS)).items.map((i) => i.id)).toEqual([art.id]);
    });

    it('clears featured, so it cannot collide with the currently featured insight', async () => {
      const art = await create({ name: 'Was featured' });
      await service.setFeatured(WS, art.id, true);
      await service.archive(WS, art.id);
      const other = await create({ name: 'Featured now' });
      await service.setFeatured(WS, other.id, true);
      // An archived row keeps its flag; only the live-featured one is unique.
      row(art.id).is_featured = true;

      const restored = await service.restore(WS, art.id);

      expect(restored.is_featured).toBe(false);
      expect(row(art.id).is_featured).toBe(false);
      expect(row(other.id).is_featured).toBe(true);
    });

    it('throws InsightNotFoundError for an insight that is not archived, without writing', async () => {
      const art = await create();
      await expect(service.restore(WS, art.id)).rejects.toThrow(InsightNotFoundError);
      expect(insightRepo.callLog).not.toContain('repo.unarchive');
    });

    it('throws InsightNotFoundError for a missing insight', async () => {
      await expect(service.restore(WS, 'nonexistent')).rejects.toThrow(InsightNotFoundError);
    });

    it('throws InsightNotFoundError when the unarchive matched nothing', async () => {
      const art = await create();
      await service.archive(WS, art.id);
      vi.spyOn(insightRepo, 'unarchive').mockResolvedValueOnce(undefined);
      await expect(service.restore(WS, art.id)).rejects.toThrow(InsightNotFoundError);
    });
  });

  describe('InsightService.delete', () => {
    it.each([
      ['an existing insight', false],
      ['an already-archived insight', true],
    ])('deletes %s', async (_label, archived) => {
      const art = await create();
      if (archived) await service.archive(WS, art.id);

      await service.delete(WS, art.id);

      expect(insightRepo.callLog).toContain('repo.hardDelete');
      expect(insightRepo.insights.find((a) => a.id === art.id)).toBeUndefined();
    });

    it('throws InsightNotFoundError when missing (and does not call hardDelete)', async () => {
      await expect(service.delete(WS, 'nonexistent-id')).rejects.toThrow(InsightNotFoundError);
      expect(insightRepo.callLog).not.toContain('repo.hardDelete');
    });

    it('throws InsightNotFoundError if hardDelete reports nothing deleted', async () => {
      const art = await create();
      vi.spyOn(insightRepo, 'hardDelete').mockResolvedValueOnce(false);
      await expect(service.delete(WS, art.id)).rejects.toThrow(InsightNotFoundError);
    });
  });

  describe('InsightService.duplicate', () => {
    it('creates copy with (copy) name, not featured, same kind/description', async () => {
      const original = await create({ name: 'Annual Review', description: 'Yearly breakdown', kind: 'report' });
      await service.setFeatured(WS, original.id, true);

      const copy = await service.duplicate(WS, original.id, 'u-dup');

      expect(copy).toMatchObject({
        name: 'Annual Review (copy)',
        is_featured: false,
        kind: 'report',
        description: 'Yearly breakdown',
        version_no: 1,
        latest_version_no: 1,
      });
    });

    it("copies the CURRENT version's html into a single v1 with trigger duplicate", async () => {
      const original = await create({ name: 'Report' });
      await publish(original.id, '<p>v2 content</p>');

      const copy = await service.duplicate(WS, original.id);

      expect(copy.html).toBe('<p>v2 content</p>');
      expect(copy.versions).toHaveLength(1);
      expect(copy.versions[0]).toMatchObject({
        version_no: 1,
        trigger: 'duplicate',
        label: 'Duplicated from "Report" v2',
      });
      expect(version(copy.id, 1).content_hash).toBe(insightContentHash('<p>v2 content</p>'));
    });

    it('picks (copy 2) on collision', async () => {
      const original = await create({ name: 'Quarterly Pitch' });
      expect((await service.duplicate(WS, original.id)).name).toBe('Quarterly Pitch (copy)');
      expect((await service.duplicate(WS, original.id)).name).toBe('Quarterly Pitch (copy 2)');
    });

    it('throws InsightNotFoundError for missing and for archived source', async () => {
      await expect(service.duplicate(WS, 'nonexistent-id')).rejects.toThrow(InsightNotFoundError);
      expect(insightRepo.callLog).not.toContain('repo.create');

      const original = await create();
      await service.archive(WS, original.id);
      await expect(service.duplicate(WS, original.id)).rejects.toThrow(InsightNotFoundError);
    });

    it('throws when there is no current version', async () => {
      const insight = await insightRepo.create({ workspace_id: WS, name: 'Orphan Insight' });
      await expect(service.duplicate(WS, insight.id)).rejects.toThrow(InsightNotFoundError);
    });

    it('copies a live binding onto the duplicate', async () => {
      const art = await create();
      await service.setAgentBinding(WS, art.id, 'dikti');
      expect((await service.duplicate(WS, art.id)).agent_key).toBe('dikti');
    });

    it('drops a deprecated binding on the duplicate', async () => {
      const svc = makeService(
        createSectorRegistry([
          { key: 'minerba', handle: '@minerba', name: 'm', sector: 'm', description: 'd', deprecated: true },
        ]),
      );
      const art = await create({}, svc);
      row(art.id).agent_key = 'minerba';

      expect((await svc.duplicate(WS, art.id)).agent_key).toBeNull();
    });
  });

  describe('InsightService source template', () => {
    const LIVE_TPL = '11111111-1111-4111-8111-111111111111';
    const DELETED_TPL = '22222222-2222-4222-8222-222222222222';
    const FOREIGN_TPL = '33333333-3333-4333-8333-333333333333';
    const UNKNOWN_TPL = '44444444-4444-4444-8444-444444444444';

    // Stands in for the workspace-scoped template repository: findLiveRefById
    // leaves soft-deleted rows out, as the real query does.
    const templates = [
      { id: LIVE_TPL, workspace_id: WS, name: 'Sector Brief', deleted: false },
      { id: DELETED_TPL, workspace_id: WS, name: 'Old Brief', deleted: true },
      { id: FOREIGN_TPL, workspace_id: 'ws-2', name: 'Their Brief', deleted: false },
    ];
    let findLiveRefById: ReturnType<typeof vi.fn>;
    let svc: InsightService;

    beforeEach(() => {
      findLiveRefById = vi.fn(async (id: string) => {
        const t = templates.find((x) => x.id === id && !x.deleted);
        return t ? { id: t.id, workspace_id: t.workspace_id, name: t.name } : null;
      });
      svc = new InsightService(
        insightRepo as unknown as any,
        versionRepo as unknown as any,
        draftRepo as unknown as any,
        mockDb as unknown as DbClient,
        undefined,
        undefined,
        { findLiveRefById } as unknown as any,
      );
    });

    it('stores a live template id in the same workspace and names it on the detail', async () => {
      const created = await create({ templateId: LIVE_TPL }, svc);

      expect(row(created.id).source_template_id).toBe(LIVE_TPL);
      expect(created).toMatchObject({
        source_template_id: LIVE_TPL,
        source_template_name: 'Sector Brief',
      });
    });

    it.each([
      ['a soft-deleted', DELETED_TPL],
      ['a foreign-workspace', FOREIGN_TPL],
      ['an unknown', UNKNOWN_TPL],
    ])('stores %s template id as null and still creates the insight', async (_label, templateId) => {
      const created = await create({ templateId }, svc);

      expect(row(created.id).source_template_id).toBeNull();
      expect(created).toMatchObject({ source_template_id: null, source_template_name: null });
      expect(version(created.id, 1).html).toBe('<p>v1</p>');
    });

    it('stores null without a lookup for a non-uuid id', async () => {
      const created = await create({ templateId: 'not-a-uuid' }, svc);

      expect(row(created.id).source_template_id).toBeNull();
      expect(findLiveRefById).not.toHaveBeenCalled();
    });

    it('stores null when the template lookup fails, and still creates the insight', async () => {
      findLiveRefById.mockRejectedValueOnce(new Error('connection reset'));

      const created = await create({ templateId: LIVE_TPL }, svc);

      expect(row(created.id).source_template_id).toBeNull();
      expect(created.versions).toHaveLength(1);
    });

    it('looks the template up before the create transaction opens', async () => {
      await create({ templateId: LIVE_TPL }, svc);

      expect(findLiveRefById.mock.invocationCallOrder[0]).toBeLessThan(
        mockDb.transaction.mock.invocationCallOrder[0],
      );
    });

    it('records nothing and looks nothing up without a template id', async () => {
      const created = await create({}, svc);

      expect(row(created.id).source_template_id).toBeNull();
      expect(findLiveRefById).not.toHaveBeenCalled();
    });

    it('get names a live source template and hides a deleted one', async () => {
      const created = await create({ templateId: LIVE_TPL }, svc);
      expect((await svc.get(WS, created.id)).source_template_name).toBe('Sector Brief');

      templates[0].deleted = true;
      try {
        const detail = await svc.get(WS, created.id);
        expect(detail.source_template_id).toBe(LIVE_TPL);
        expect(detail.source_template_name).toBeNull();
      } finally {
        templates[0].deleted = false;
      }
    });

    it('publish and rollback details keep the source template name', async () => {
      const created = await create({ templateId: LIVE_TPL }, svc);

      const published = await svc.publishVersion({ workspaceId: WS, insightId: created.id, html: '<p>v2</p>' });
      expect(published.source_template_name).toBe('Sector Brief');

      const rolledBack = await svc.rollback({ workspaceId: WS, insightId: created.id, toVersionNo: 1 });
      expect(rolledBack.source_template_name).toBe('Sector Brief');
    });

    it('duplicate carries the source template id over', async () => {
      const original = await create({ templateId: LIVE_TPL }, svc);

      const copy = await svc.duplicate(WS, original.id);

      expect(row(copy.id).source_template_id).toBe(LIVE_TPL);
      expect(copy).toMatchObject({ source_template_id: LIVE_TPL, source_template_name: 'Sector Brief' });
    });

    it('duplicate carries the id of a since-deleted template, without naming it', async () => {
      const original = await create({ templateId: LIVE_TPL }, svc);
      templates[0].deleted = true;
      try {
        const copy = await svc.duplicate(WS, original.id);
        expect(row(copy.id).source_template_id).toBe(LIVE_TPL);
        expect(copy.source_template_name).toBeNull();
      } finally {
        templates[0].deleted = false;
      }
    });

    it('a service without a template lookup records no source', async () => {
      const created = await create({ templateId: LIVE_TPL });

      expect(row(created.id).source_template_id).toBeNull();
      expect(created.source_template_name).toBeNull();
    });
  });

  describe('InsightService.getRunDraft', () => {
    it('returns the draft when present', async () => {
      await seedDraft('run-get-1', 'art-1', '<p>draft content</p>');
      expect((await service.getRunDraft(WS, 'run-get-1'))?.html).toBe('<p>draft content</p>');
    });

    it('returns undefined when missing', async () => {
      expect(await service.getRunDraft(WS, 'run-missing')).toBeUndefined();
    });
  });

  describe('InsightService.applyRunDraftEdit', () => {
    it('first edit seeds from the current version and records its version_no as base', async () => {
      const art = await create({ name: 'Seed Test Doc', html: section('summary', '<p>Seed summary</p>') });
      const edited = section('summary', '<p>Edited summary</p>');

      const result = await editDraft('run-seed', art.id, { kind: 'section', section: 'summary', html: edited });

      expect(result).toMatchObject({ insightId: art.id, insightName: 'Seed Test Doc', baseVersionNo: 1 });
      const draft = await draftRepo.findByRunId('run-seed', WS);
      expect(draft).toMatchObject({ base_version_no: 1, html: edited });
    });

    it('second edit builds on the draft html and keeps the original base', async () => {
      const art = await create({
        html: section('summary', '<p>Summary v1</p>') + section('details', '<p>Details v1</p>'),
      });

      await editDraft('run-multi', art.id, {
        kind: 'section',
        section: 'summary',
        html: section('summary', '<p>Summary edit 1</p>'),
      });
      const result2 = await editDraft('run-multi', art.id, {
        kind: 'section',
        section: 'details',
        html: section('details', '<p>Details edit 2</p>'),
      });

      expect(result2.baseVersionNo).toBe(1);
      const draft = await draftRepo.findByRunId('run-multi', WS);
      expect(draft?.base_version_no).toBe(1);
      expect(draft?.html).toContain('<p>Summary edit 1</p>');
      expect(draft?.html).toContain('<p>Details edit 2</p>');
    });

    it('supports full document edits', async () => {
      const art = await create();

      const result = await editDraft('run-doc', art.id, {
        kind: 'document',
        html: '<div><p>Complete new document</p></div>',
      });

      expect(result.baseVersionNo).toBe(1);
      expect((await draftRepo.findByRunId('run-doc', WS))?.html).toBe('<div><p>Complete new document</p></div>');
    });

    it("different insight than the run's draft throws InsightValidationError", async () => {
      const art1 = await create({ name: 'Doc 1' });
      const art2 = await create({ name: 'Doc 2' });
      await editDraft('run-conflict', art1.id, { kind: 'document', html: '<p>new doc 1</p>' });

      await expect(
        editDraft('run-conflict', art2.id, { kind: 'document', html: '<p>new doc 2</p>' }),
      ).rejects.toThrow(InsightValidationError);
    });

    it('missing section throws InsightValidationError', async () => {
      const art = await create({ html: section('existing', '<p>content</p>') });
      await expect(
        editDraft('run-missing-sec', art.id, {
          kind: 'section',
          section: 'nonexistent',
          html: section('nonexistent', '<p>new</p>'),
        }),
      ).rejects.toThrow(InsightValidationError);
    });

    it('archived insight throws InsightNotFoundError', async () => {
      const art = await create();
      await service.archive(WS, art.id);
      await expect(
        editDraft('run-arch', art.id, { kind: 'document', html: '<p>new</p>' }),
      ).rejects.toThrow(InsightNotFoundError);
    });

    it.each([
      ['spliced HTML document trimmed empty', '   \n  ', InsightValidationError],
      ['HTML exceeding MAX_INSIGHT_BYTES', '<p>' + 'z'.repeat(MAX_INSIGHT_BYTES + 5) + '</p>', InsightPayloadTooLargeError],
      ['invalid insight document placeholder', 'plain text without any html tags', InsightValidationError],
    ])('%s throws %O', async (_label, html, ErrorType) => {
      const art = await create();
      await expect(editDraft('run-bad', art.id, { kind: 'document', html })).rejects.toThrow(ErrorType);
    });

    it('two concurrent edits to different sections with a lock-honouring fake (lockById awaits a mutex held until the tx callback resolves) both survive in the final draft html', async () => {
      const art = await create({
        html: section('sec-a', '<p>Original A</p>') + section('sec-b', '<p>Original B</p>'),
      });

      let lockedByTx: string | null = null;
      const waiters: Array<() => void> = [];
      const acquireLock = async (txId: string) => {
        while (lockedByTx !== null && lockedByTx !== txId) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        lockedByTx = txId;
      };
      const releaseLock = (txId: string) => {
        if (lockedByTx === txId) {
          lockedByTx = null;
          waiters.shift()?.();
        }
      };

      let txIdCounter = 0;
      mockDb = {
        transaction: vi.fn(async (callback) => {
          const currentTx = `tx-${++txIdCounter}`;
          try {
            return await callback(currentTx);
          } finally {
            releaseLock(currentTx);
          }
        }),
      };
      const originalLockById = insightRepo.lockById.bind(insightRepo);
      insightRepo.lockById = async (id, ws, tx) => {
        await acquireLock(tx as string);
        await new Promise((resolve) => setTimeout(resolve, 15));
        return originalLockById(id, ws, tx);
      };
      const concurrentService = makeService();

      const runId = 'concurrent-run-1';
      await Promise.all(
        (['sec-a', 'sec-b'] as const).map((sec, i) =>
          editDraft(
            runId,
            art.id,
            { kind: 'section', section: sec, html: section(sec, `<p>Updated ${'AB'[i]}</p>`) },
            concurrentService,
          ),
        ),
      );

      const finalDraft = await draftRepo.findByRunId(runId, WS);
      expect(finalDraft!.html).toContain('<p>Updated A</p>');
      expect(finalDraft!.html).toContain('<p>Updated B</p>');
    });
  });

  describe('InsightService.publishRunDraft', () => {
    it('happy path (appends trigger routine, created_by null, source_run_id = runId, label Scheduled refresh, deletes the draft, returns ownerUserId)', async () => {
      const art = await create({ name: 'Happy Path Doc', userId: 'user-owner' });
      await seedDraft('run-happy', art.id, '<p>v1 refreshed</p>');

      const res = await service.publishRunDraft(WS, 'run-happy', art.id);

      expect(res).toEqual({
        status: 'published',
        insightId: art.id,
        insightName: 'Happy Path Doc',
        versionNo: 2,
        baseMoved: false,
        ownerUserId: 'user-owner',
      });
      expect(version(art.id, 2)).toMatchObject({
        trigger: 'routine',
        created_by: null,
        source_run_id: 'run-happy',
        label: 'Scheduled refresh',
        is_unchanged: false,
        content_hash: insightContentHash('<p>v1 refreshed</p>'),
      });
      expect(insightRepo.callLog).toContain('repo.update');
      expect(await draftRepo.findByRunId('run-happy', WS)).toBeUndefined();
    });

    it('idempotent — existing routine version returns already_published, no create, no delete', async () => {
      const art = await create();
      await versionRepo.create({
        workspace_id: WS,
        insight_id: art.id,
        version_no: 2,
        html: '<p>v2</p>',
        trigger: 'routine',
        source_run_id: 'run-idemp',
      });
      const versionCountBefore = versionRepo.versions.length;
      draftRepo.callLog = [];
      versionRepo.callLog = [];

      const res = await service.publishRunDraft(WS, 'run-idemp', art.id);

      expect(res).toEqual({ status: 'already_published', insightId: art.id, versionNo: 2 });
      expect(versionRepo.callLog).not.toContain('versionRepo.create');
      expect(draftRepo.callLog).not.toContain('draftRepo.deleteByRunId');
      expect(versionRepo.versions.length).toBe(versionCountBefore);
    });

    it('base moved (current v5, draft base v3) publishes with label Scheduled refresh (base moved from v3) and no StaleInsightVersionError', async () => {
      const art = await create();
      for (let n = 2; n <= 5; n++) await publish(art.id, `<p>v${n}</p>`, { baseVersionNo: n - 1 });
      await seedDraft('run-moved', art.id, '<p>v3 refreshed content</p>', 3);

      const res = await service.publishRunDraft(WS, 'run-moved', art.id);

      expect(res).toMatchObject({ status: 'published', baseMoved: true, versionNo: 6 });
      expect(version(art.id, 6)).toMatchObject({
        trigger: 'routine',
        label: 'Scheduled refresh (base moved from v3)',
      });
    });

    it('no draft appends an is_unchanged routine version carrying the current html and returns unchanged', async () => {
      const art = await create({ userId: 'user-owner' });
      const updatedAtBefore = insightRepo.insights[0].updated_at;
      insightRepo.callLog = [];

      const res = await service.publishRunDraft(WS, 'run-no-draft', art.id);

      expect(res).toEqual({ status: 'unchanged', insightId: art.id, versionNo: 2 });
      expect(version(art.id, 2)).toMatchObject({
        trigger: 'routine',
        is_unchanged: true,
        html: '<p>v1</p>',
        label: UNCHANGED_REFRESH_LABEL,
        source_run_id: 'run-no-draft',
        content_hash: insightContentHash('<p>v1</p>'),
      });
      // An unchanged refresh leaves the insight row (updated_at/updated_by) alone.
      expect(insightRepo.callLog).not.toContain('repo.update');
      expect(insightRepo.insights[0]).toMatchObject({ updated_at: updatedAtBefore, updated_by: 'user-owner' });
    });

    it('a draft whose hash equals the current version appends an is_unchanged version, deletes the draft and returns unchanged', async () => {
      const art = await create({ html: '<html>\n<body><p>same</p></body>\n</html>' });
      // Only whitespace differs, which the hash normalises away.
      await seedDraft('run-same', art.id, '<html>\n  <body><p>same</p></body>\n</html>\n');

      const res = await service.publishRunDraft(WS, 'run-same', art.id);

      expect(res).toEqual({ status: 'unchanged', insightId: art.id, versionNo: 2 });
      const v1 = version(art.id, 1);
      // Stores the current version's exact html, not the whitespace-variant draft.
      expect(version(art.id, 2)).toMatchObject({
        is_unchanged: true,
        label: UNCHANGED_REFRESH_LABEL,
        content_hash: v1.content_hash,
        html: v1.html,
      });
      expect(await draftRepo.findByRunId('run-same', WS)).toBeUndefined();
    });

    it('an equal-hash draft is recorded unchanged even when it would fail the structural check', async () => {
      // A legacy document that predates the structural check; the refresh left it alone.
      const legacyHtml = '<html><body><script>unclosed tag';
      const art = await create({ html: legacyHtml });
      await seedDraft('run-legacy', art.id, legacyHtml);

      expect((await service.publishRunDraft(WS, 'run-legacy', art.id)).status).toBe('unchanged');
    });

    it('a null current hash (pre-MB-559 version) never counts as equal, so an identical draft publishes', async () => {
      const art = await create();
      versionRepo.versions[0].content_hash = null;
      await seedDraft('run-null-hash', art.id, '<p>v1</p>');

      const res = await service.publishRunDraft(WS, 'run-null-hash', art.id);

      expect(res.status).toBe('published');
      expect(version(art.id, 2)).toMatchObject({
        is_unchanged: false,
        content_hash: insightContentHash('<p>v1</p>'),
      });
    });

    it('idempotent after an unchanged run — a retry returns already_published and writes nothing', async () => {
      const art = await create();
      await service.publishRunDraft(WS, 'run-unchanged-retry', art.id);
      const countAfterFirst = versionRepo.versions.length;

      const res = await service.publishRunDraft(WS, 'run-unchanged-retry', art.id);

      expect(res).toEqual({ status: 'already_published', insightId: art.id, versionNo: 2 });
      expect(versionRepo.versions.length).toBe(countAfterFirst);
    });

    it('no draft on an archived insight throws insight_archived and writes nothing', async () => {
      const art = await create();
      await service.archive(WS, art.id);
      versionRepo.callLog = [];

      await expect(service.publishRunDraft(WS, 'run-archived-no-draft', art.id)).rejects.toMatchObject({
        code: 'insight_archived',
      });
      expect(versionRepo.callLog).not.toContain('versionRepo.create');
    });

    it('structural fail throws code structural_check_failed, create NOT called, deleteByRunId NOT called', async () => {
      const art = await create();
      await seedDraft('run-bad-struct', art.id, '<html><body><script>unclosed tag');
      versionRepo.callLog = [];
      draftRepo.callLog = [];

      const err = await service.publishRunDraft(WS, 'run-bad-struct', art.id).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InsightRunPublishError);
      expect(err).toMatchObject({ code: 'structural_check_failed' });
      expect((err as Error).message).toContain('refresh draft failed the structural check:');
      expect(versionRepo.callLog).not.toContain('versionRepo.create');
      expect(draftRepo.callLog).not.toContain('draftRepo.deleteByRunId');
      expect(await draftRepo.findByRunId('run-bad-struct', WS)).toBeDefined();
    });

    it('archived insight throws code insight_archived, nothing created', async () => {
      const art = await create({ name: 'Archived Insight Doc' });
      await service.archive(WS, art.id);
      await seedDraft('run-archived-insight', art.id, '<p>valid html</p>');
      versionRepo.callLog = [];

      const err = await service.publishRunDraft(WS, 'run-archived-insight', art.id).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InsightRunPublishError);
      expect(err).toMatchObject({
        code: 'insight_archived',
        message: 'insight "Archived Insight Doc" is archived; the refresh was not published',
      });
      expect(versionRepo.callLog).not.toContain('versionRepo.create');
    });

    it('missing insight throws code insight_not_found', async () => {
      await seedDraft('run-missing-art', 'art-nonexistent', '<p>valid html</p>');

      const err = await service.publishRunDraft(WS, 'run-missing-art', 'art-nonexistent').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InsightRunPublishError);
      expect(err).toMatchObject({ code: 'insight_not_found' });
    });
  });

  describe('content_hash on every version write', () => {
    it('create, publish and rollback each store the hash of the html they write', async () => {
      const art = await create({ html: '<p>a</p>' });
      await publish(art.id, '<p>b</p>');
      await service.rollback({ workspaceId: WS, insightId: art.id, toVersionNo: 1 });

      expect(versionRepo.versions.map((v) => [v.content_hash, v.is_unchanged])).toEqual([
        [insightContentHash('<p>a</p>'), false],
        [insightContentHash('<p>b</p>'), false],
        [insightContentHash('<p>a</p>'), false],
      ]);
    });

    it('version summaries carry source_run_id and is_unchanged', async () => {
      const art = await create();
      await service.publishRunDraft(WS, 'run-summary', art.id);

      const detail = await service.get(WS, art.id);

      expect(detail.versions[0]).toMatchObject({ version_no: 2, source_run_id: 'run-summary', is_unchanged: true });
      expect(detail.versions[1]).toMatchObject({ source_run_id: null, is_unchanged: false });
    });
  });

  describe('InsightService.findVersionForRun', () => {
    it('returns the workspace-scoped version link for the run', async () => {
      const art = await create();
      await service.publishRunDraft(WS, 'run-link', art.id);

      expect(await service.findVersionForRun(WS, 'run-link')).toEqual({
        insight_id: art.id,
        insight_name: 'Name',
        version_no: 2,
        is_unchanged: true,
      });
      expect(versionRepo.latestBySourceRunIdCalls).toEqual([{ runId: 'run-link', workspaceId: WS }]);
    });

    it('returns undefined when the run produced no version', async () => {
      expect(await service.findVersionForRun(WS, 'run-none')).toBeUndefined();
    });
  });

  describe('InsightService.findBoundAgent', () => {
    it("returns the insight's raw bound agent key", async () => {
      const art = await create();
      row(art.id).agent_key = 'bangun';
      await expect(service.findBoundAgent(WS, art.id)).resolves.toEqual({ agentKey: 'bangun' });
    });

    it('returns a null key for an unbound insight', async () => {
      const art = await create();
      await expect(service.findBoundAgent(WS, art.id)).resolves.toEqual({ agentKey: null });
    });

    it('reads one insight row and no versions', async () => {
      const art = await create();
      insightRepo.callLog = [];
      const versionSpy = vi.spyOn(versionRepo, 'findByInsightId');

      await service.findBoundAgent(WS, art.id);

      expect(insightRepo.callLog).toEqual(['repo.findById']);
      expect(versionSpy).not.toHaveBeenCalled();
    });

    it('returns null for an insight in another workspace or an archived one', async () => {
      const art = await create();
      row(art.id).agent_key = 'bangun';
      await expect(service.findBoundAgent('ws-2', art.id)).resolves.toBeNull();

      row(art.id).archived_at = new Date().toISOString();
      await expect(service.findBoundAgent(WS, art.id)).resolves.toBeNull();
    });
  });

  describe('InsightService.getChatContext', () => {
    // The outline memo is process-wide and keyed by version id + name. The mock
    // repository reuses version ids across tests, so every test here names its
    // insight uniquely to keep the memo from carrying over.
    let seq = 0;
    const uniqueName = () => `Outline fixture ${++seq}-${Math.random().toString(36).slice(2)}`;
    const DOC =
      '<section data-section="summary"><h2>Summary</h2><table><caption>Cohort</caption>' +
      '<tr><th>Name</th><th>Students</th></tr><tr><td>Uni A</td><td>1,200</td></tr></table></section>';

    it("returns the current version's outline with its number and publish time", async () => {
      const name = uniqueName();
      const art = await create({ name, html: DOC });
      await publish(art.id, DOC.replace('1,200', '1,350'));

      const ctx = await service.getChatContext(WS, art.id);

      expect(ctx).toMatchObject({
        insightId: art.id,
        name,
        versionNo: 2,
        publishedAt: version(art.id, 2).created_at,
        truncated: false,
      });
      expect(ctx!.outline).toContain(`Insight "${name}" · version 2`);
      expect(ctx!.outline).toContain('| Uni A | 1,350 |');
      expect(ctx!.outline).not.toContain('1,200');
    });

    it('returns null for an insight in another workspace or a missing one', async () => {
      const art = await create({ name: uniqueName(), html: DOC });
      await expect(service.getChatContext('ws-2', art.id)).resolves.toBeNull();
      await expect(service.getChatContext(WS, 'no-such-insight')).resolves.toBeNull();
    });

    it('returns null for an archived insight without reading its versions', async () => {
      const art = await create({ name: uniqueName(), html: DOC });
      row(art.id).archived_at = new Date().toISOString();
      versionRepo.callLog = [];

      await expect(service.getChatContext(WS, art.id)).resolves.toBeNull();
      expect(versionRepo.callLog).toEqual([]);
    });

    it('memoises the outline per version: a repeat turn reads no HTML', async () => {
      const art = await create({ name: uniqueName(), html: DOC });
      const first = await service.getChatContext(WS, art.id);
      versionRepo.callLog = [];

      expect(await service.getChatContext(WS, art.id)).toEqual(first);
      expect(versionRepo.callLog).toEqual(['versionRepo.findCurrentHead']);
    });

    it('builds a fresh outline once a new version is published', async () => {
      const art = await create({ name: uniqueName(), html: DOC });
      await service.getChatContext(WS, art.id);
      await publish(art.id, DOC.replace('Uni A', 'Uni B'));
      versionRepo.callLog = [];

      const ctx = await service.getChatContext(WS, art.id);

      expect(versionRepo.callLog).toEqual(['versionRepo.findCurrentHead', 'versionRepo.findByVersionNo']);
      expect(ctx!.versionNo).toBe(2);
      expect(ctx!.outline).toContain('| Uni B | 1,200 |');
    });
  });

  describe('InsightService.getHead', () => {
    const DOC = '<section data-section="summary"><h2>Summary</h2><p>Revenue $5bn</p></section>';

    it("returns the current version's number, publish time and trigger without reading its HTML", async () => {
      const art = await create({ html: DOC });
      await publish(art.id, DOC.replace('$5bn', '$6bn'));
      const v2 = version(art.id, 2);
      versionRepo.callLog = [];

      expect(await service.getHead(WS, art.id)).toEqual({
        version_no: 2,
        created_at: v2.created_at,
        trigger: v2.trigger,
      });
      expect(versionRepo.callLog).toEqual(['versionRepo.findCurrentHead']);
    });

    it('returns null for a missing, archived or other-workspace insight', async () => {
      const art = await create({ html: DOC });

      expect(await service.getHead('ws-2', art.id)).toBeNull();
      expect(await service.getHead(WS, '00000000-0000-4000-8000-000000000000')).toBeNull();
      await service.archive(WS, art.id);
      expect(await service.getHead(WS, art.id)).toBeNull();
    });
  });

  describe('InsightService.setAgentBinding', () => {
    const agent = (key: SectorAgentEntry['key'], extra: Partial<SectorAgentEntry> = {}): SectorAgentEntry => ({
      key,
      handle: `@${key}`,
      name: `${key} agent`,
      sector: key,
      description: 'd',
      deprecated: false,
      ...extra,
    });

    // minerba is deprecated in favour of bangun in this fixture.
    const fixtureRegistry = createSectorRegistry([
      agent('minerba', { deprecated: true, successorKey: 'bangun' }),
      agent('dikti'),
      agent('bangun'),
    ]);

    it('binds an unbound insight and returns agent_key on the summary', async () => {
      const art = await create();

      const summary = await service.setAgentBinding(WS, art.id, 'bangun', 'u1');

      expect(summary).toMatchObject({ agent_key: 'bangun', latest_version_no: 1 });
      expect(row(art.id)).toMatchObject({ agent_key: 'bangun', updated_by: 'u1' });
    });

    it('unbinds with null (back to the general CoPilot)', async () => {
      const art = await create();
      await service.setAgentBinding(WS, art.id, 'minerba');

      expect((await service.setAgentBinding(WS, art.id, null)).agent_key).toBeNull();
      expect(row(art.id).agent_key).toBeNull();
    });

    it('rejects an unknown agent key with InsightValidationError and writes nothing', async () => {
      const art = await create();
      insightRepo.callLog = [];

      await expect(service.setAgentBinding(WS, art.id, 'nope')).rejects.toThrow(InsightValidationError);
      expect(insightRepo.callLog).not.toContain('repo.update');
    });

    it('rejects a non-string, non-null key', async () => {
      const art = await create();
      await expect(service.setAgentBinding(WS, art.id, 42 as unknown as string)).rejects.toThrow(
        InsightValidationError,
      );
    });

    it('rejects binding a deprecated agent and names its successor', async () => {
      const svc = makeService(fixtureRegistry);
      const art = await create({}, svc);
      insightRepo.callLog = [];

      await expect(svc.setAgentBinding(WS, art.id, 'minerba')).rejects.toThrow(
        /@minerba is deprecated.*bind @bangun instead/,
      );
      expect(insightRepo.callLog).not.toContain('repo.update');
    });

    it('treats re-saving a current deprecated binding as a no-op', async () => {
      const svc = makeService(fixtureRegistry);
      const art = await create({}, svc);
      // Bound before the agent was deprecated.
      row(art.id).agent_key = 'minerba';
      const before = { ...row(art.id) };
      insightRepo.callLog = [];

      const summary = await svc.setAgentBinding(WS, art.id, 'minerba', 'u2');

      expect(summary.agent_key).toBe('minerba');
      expect(insightRepo.callLog).not.toContain('repo.update');
      expect(row(art.id)).toEqual(before);
    });

    it('lets an insight on a deprecated agent move off it', async () => {
      const svc = makeService(fixtureRegistry);
      const art = await create({}, svc);
      row(art.id).agent_key = 'minerba';

      expect((await svc.setAgentBinding(WS, art.id, 'bangun')).agent_key).toBe('bangun');
      // ...and it cannot then go back.
      await expect(svc.setAgentBinding(WS, art.id, 'minerba')).rejects.toThrow(InsightValidationError);
    });

    it('refuses an archived insight with InsightNotFoundError', async () => {
      const art = await create();
      await service.archive(WS, art.id);
      await expect(service.setAgentBinding(WS, art.id, 'bangun')).rejects.toThrow(InsightNotFoundError);
    });

    describe('resuming a refresh schedule paused for a broken binding (MB-560)', () => {
      const pausedRoutine = (overrides: Record<string, unknown> = {}) => ({
        id: 'rt-1',
        insight_id: 'ins',
        enabled: false,
        paused_reason: 'agent_deprecated',
        cron_expression: '0 9 * * 1',
        timezone: 'Asia/Jakarta',
        schedule_kind: 'weekly',
        schedule_spec: { time: '09:00', weekdays: [1] },
        next_fire_at: '2020-01-06T02:00:00.000Z',
        archived_at: null,
        ...overrides,
      });

      function setup(routine: Record<string, unknown> | null) {
        const routines = {
          findActiveByInsightId: vi.fn().mockResolvedValue(routine),
          resumeFromAgentPause: vi.fn().mockResolvedValue(routine),
        };
        return { svc: makeService(fixtureRegistry, routines), routines };
      }

      async function insightOnDeprecated(svc: InsightService) {
        const art = await create({}, svc);
        row(art.id).agent_key = 'minerba';
        return art;
      }

      it('rebinding to a valid agent resumes it with next_fire_at recomputed from now, leaving the cadence to the routine', async () => {
        const { svc, routines } = setup(pausedRoutine());
        const art = await insightOnDeprecated(svc);
        const before = Date.now();

        await svc.setAgentBinding(WS, art.id, 'bangun');

        expect(routines.findActiveByInsightId).toHaveBeenCalledWith(art.id);
        expect(routines.resumeFromAgentPause).toHaveBeenCalledTimes(1);
        const [id, nextFireAt] = routines.resumeFromAgentPause.mock.calls[0]!;
        expect(id).toBe('rt-1');
        // Next Monday 09:00 Jakarta after now — never the stale 2020 backlog.
        const next = new Date(nextFireAt as string);
        expect(next.getTime()).toBeGreaterThan(before);
        expect(next.getUTCDay()).toBe(1);
        expect(next.getUTCHours()).toBe(2);
        // Only (id, next_fire_at) reach the write: no cadence column is touched.
        expect(routines.resumeFromAgentPause.mock.calls[0]).toHaveLength(2);
      });

      it.each([
        ['unbinding (back to general) resumes it', null, 'agent_deprecated'],
        ['resumes an agent_incompatible pause the same way', 'dikti', 'agent_incompatible'],
      ])('%s', async (_label, target, paused_reason) => {
        const { svc, routines } = setup(pausedRoutine({ paused_reason }));
        const art = await insightOnDeprecated(svc);

        await svc.setAgentBinding(WS, art.id, target);

        expect(routines.resumeFromAgentPause).toHaveBeenCalledTimes(1);
      });

      it('never resumes a manual pause (no reason)', async () => {
        const { svc, routines } = setup(pausedRoutine({ paused_reason: null }));
        const art = await insightOnDeprecated(svc);

        await svc.setAgentBinding(WS, art.id, 'bangun');

        expect(routines.resumeFromAgentPause).not.toHaveBeenCalled();
      });

      it('re-saving the same deprecated key resumes nothing', async () => {
        const { svc, routines } = setup(pausedRoutine());
        const art = await insightOnDeprecated(svc);

        await svc.setAgentBinding(WS, art.id, 'minerba');

        expect(routines.findActiveByInsightId).not.toHaveBeenCalled();
        expect(routines.resumeFromAgentPause).not.toHaveBeenCalled();
      });

      it('an insight with no routine is fine', async () => {
        const { svc, routines } = setup(null);
        const art = await insightOnDeprecated(svc);

        await expect(svc.setAgentBinding(WS, art.id, 'bangun')).resolves.toMatchObject({ agent_key: 'bangun' });
        expect(routines.resumeFromAgentPause).not.toHaveBeenCalled();
      });

      it('a refused binding (deprecated, unknown) resumes nothing', async () => {
        const { svc, routines } = setup(pausedRoutine());
        const art = await create({}, svc);

        await expect(svc.setAgentBinding(WS, art.id, 'minerba')).rejects.toThrow();
        await expect(svc.setAgentBinding(WS, art.id, 'nope')).rejects.toThrow();
        expect(routines.resumeFromAgentPause).not.toHaveBeenCalled();
      });

      it('without a routines dependency (the workforce publish path) binding still works', async () => {
        const svc = makeService(fixtureRegistry);
        const art = await insightOnDeprecated(svc);

        await expect(svc.setAgentBinding(WS, art.id, 'bangun')).resolves.toMatchObject({ agent_key: 'bangun' });
      });
    });

    it('never creates a version and leaves past version stamps untouched', async () => {
      const art = await create({ agentStamp: { agentKey: 'dikti' } });
      versionRepo.callLog = [];

      await service.setAgentBinding(WS, art.id, 'bangun');
      await service.setAgentBinding(WS, art.id, null);

      expect(versionRepo.callLog).not.toContain('versionRepo.create');
      expect(versionRepo.versions).toHaveLength(1);
      expect(versionRepo.versions[0]).toMatchObject({ agent_key: 'dikti' });
    });

    it('is workspace-scoped: another workspace cannot bind the insight', async () => {
      const art = await create();

      await expect(service.setAgentBinding('ws-2', art.id, 'bangun')).rejects.toThrow(InsightNotFoundError);
      expect(row(art.id).agent_key).toBeNull();
    });
  });

  describe('agent stamp on version writes', () => {
    const stamp = { agentKey: 'bangun' };

    it('every current write path stores a null agent_key by default', async () => {
      const art = await create();
      await publish(art.id, '<p>b</p>');
      await service.rollback({ workspaceId: WS, insightId: art.id, toVersionNo: 1 });
      await service.duplicate(WS, art.id);
      await service.publishRunDraft(WS, 'run-nostamp', art.id);

      expect(versionRepo.versions.length).toBe(5);
      for (const v of versionRepo.versions) {
        expect(v).toMatchObject({ agent_key: null });
      }
    });

    it('createFromDocument persists the stamp on v1 without binding the insight', async () => {
      const art = await create({ agentStamp: stamp });

      expect(versionRepo.versions[0]).toMatchObject({ agent_key: 'bangun' });
      expect(art.agent_key).toBeNull();
      expect(art.versions[0]).toMatchObject({ agent_key: 'bangun' });
    });

    it('publishVersion (appendVersion) persists the stamp and the summary includes it', async () => {
      const art = await create();

      const detail = await publish(art.id, '<p>b</p>', { agentStamp: stamp });

      expect(detail.versions[0]).toMatchObject({ version_no: 2, agent_key: 'bangun' });
      expect(detail.versions[1]).toMatchObject({ agent_key: null });
    });

    it('publishRunDraft stamps the routine version when given a stamp', async () => {
      const art = await create();

      await service.publishRunDraft(WS, 'run-stamped', art.id, stamp);

      expect(version(art.id, 2)).toMatchObject({ trigger: 'routine', agent_key: 'bangun' });
    });
  });

  // Marker rules themselves are covered in evidenceMarkers.test.ts; these prove
  // each author-facing write path runs the check and maps the refusal.
  describe('evidence markers on @dikti version writes (MB-543)', () => {
    const dikti = { agentKey: 'dikti' };
    const BAD = '<p><span data-evidence="inferred">Inferred</span> the buyer is X.</p>';

    it('createFromDocument refuses a @dikti v1 with a malformed marker and writes nothing', async () => {
      await expect(create({ html: BAD, agentStamp: dikti })).rejects.toThrow(InsightEvidenceMarkerError);
      expect(insightRepo.insights).toHaveLength(0);
      expect(versionRepo.versions).toHaveLength(0);
    });

    it('publishVersion refuses a @dikti version with a malformed marker, as a validation error', async () => {
      const art = await create();

      const err = await publish(art.id, BAD, { agentStamp: dikti }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InsightValidationError);
      expect((err as Error).message).toContain('data-based-on');
      expect((err as Error).message).toContain('may sit outside the part you changed');
      expect(versionRepo.versions).toHaveLength(1);
    });

    it("does not validate another agent's or an unstamped write", async () => {
      const art = await create({ html: BAD, agentStamp: { agentKey: 'bangun' } });
      await publish(art.id, BAD);
      expect(versionRepo.versions).toHaveLength(2);
    });
  });

  describe('source and unavailable markers on every version write (MB-551, MB-556)', () => {
    const SOURCES = sourcesSectionHtml([
      { id: 'S1', kind: 'web', retrieved: '2026-09-01', feeds: 'FY2025 output', name: 'ESDM', locator: 'https://modi.esdm.go.id/' },
    ]);
    const DANGLING = `<section data-section="output"><p>62 Mt${sourceRefHtml('S2')}</p></section>${SOURCES}`;

    it('createFromDocument refuses an unstamped (general CoPilot or person) write with a dangling reference and writes nothing', async () => {
      const err = await create({ html: DANGLING, agentStamp: null }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InsightEvidenceMarkerError);
      expect(err).toBeInstanceOf(InsightValidationError);
      expect((err as Error).message).toContain('reference S2 matches no Sources entry');
      expect(insightRepo.insights).toHaveLength(0);
      expect(versionRepo.versions).toHaveLength(0);
    });

    it("applyRunDraftEdit checks the spliced draft: a section's reference must resolve somewhere in it", async () => {
      const art = await create({ html: `<section data-section="output"><p>old</p></section>${SOURCES}` });

      // Resolves to S1 in the Sources section outside the fragment → accepted.
      await editDraft('run-src', art.id, {
        kind: 'section',
        section: 'output',
        html: section('output', `<p>62 Mt${sourceRefHtml('S1')}</p>`),
      });
      expect((await draftRepo.findByRunId('run-src', WS))?.html).toContain('data-source-ref="S1"');

      // S3 has no entry anywhere → refused, draft unchanged.
      await expect(
        editDraft('run-src', art.id, {
          kind: 'section',
          section: 'output',
          html: section('output', `<p>63 Mt${sourceRefHtml('S3')}</p>`),
        }),
      ).rejects.toThrow(/reference S3 matches no Sources entry/);
      expect((await draftRepo.findByRunId('run-src', WS))?.html).toContain('62 Mt');
    });

    it('never refuses a rollback or a refresh publish of already-written HTML', async () => {
      const art = await create();
      // A legacy version written before either check, straight into the repo.
      versionRepo.versions[0].html =
        DANGLING + '<p><span data-evidence="inferred">Inferred</span> the buyer is X.</p>';

      await service.rollback({ workspaceId: WS, insightId: art.id, toVersionNo: 1 });
      await service.publishRunDraft(WS, 'run-legacy', art.id, { agentKey: 'dikti' });

      expect(versionRepo.versions).toHaveLength(3);
    });
  });
});
