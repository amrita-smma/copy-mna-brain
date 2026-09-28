import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  repoList: vi.fn(),
  repoListDeleted: vi.fn(),
  repoFindById: vi.fn(),
  repoInsert: vi.fn(),
  repoUpdate: vi.fn(),
  repoSoftDelete: vi.fn(),
  repoRestore: vi.fn(),
  repoHardDelete: vi.fn(),
  countBySourceTemplate: vi.fn(),
}));

import {
  InsightTemplateService,
  InsightTemplateValidationError,
  InsightTemplateNotFoundError,
  InsightTemplateTooLargeError,
  SAVE_AS_TEMPLATE_TOO_LARGE_HINT,
} from './insightTemplateService';
import type { InsightTemplateRepository } from '@/lib/repositories';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/toolValidation';
import {
  CHAT_INLINE_DOCUMENT_MAX_CHARS,
  INSIGHT_TEMPLATE_MAX_CHARS,
} from '@/lib/insights/templateAttachment';
import { WORKFORCE_TEMPLATE_PART_CHARS } from '@/lib/insights/largeDocument';

class MockInsightTemplateRepository {
  list = mocks.repoList;
  listDeleted = mocks.repoListDeleted;
  findById = mocks.repoFindById;
  insert = mocks.repoInsert;
  update = mocks.repoUpdate;
  softDelete = mocks.repoSoftDelete;
  restore = mocks.repoRestore;
  hardDelete = mocks.repoHardDelete;
}

class MockInsightRepository {
  countBySourceTemplate = mocks.countBySourceTemplate;
}

const WORKSPACE_ID = 'ws-test-456';

const tpl = (overrides: Record<string, unknown> = {}) => ({
  id: 'tpl-1',
  workspace_id: 'ws-test-456',
  name: 'Template 1',
  description: null,
  icon: null,
  html: '<h1>Template 1</h1>',
  created_by: null,
  created_at: '2026-09-23T00:00:00Z',
  updated_at: '2026-09-23T00:00:00Z',
  deleted_at: null,
  ...overrides,
});

const OVERSIZED = 'x'.repeat(INSIGHT_TEMPLATE_MAX_CHARS + 1);

describe('InsightTemplateService', () => {
  let service: InsightTemplateService;
  const create = (overrides: Partial<Parameters<InsightTemplateService['create']>[0]> = {}) =>
    service.create({ name: 'Template', html: '<p>content</p>', ...overrides });

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.repoList.mockResolvedValue([]);
    mocks.countBySourceTemplate.mockResolvedValue([]);
    service = new InsightTemplateService(
      new MockInsightTemplateRepository() as unknown as InsightTemplateRepository,
      new MockInsightRepository(),
      WORKSPACE_ID,
    );
  });

  describe('InsightTemplateService.getHtml', () => {
    it('returns the HTML stored on the row', async () => {
      mocks.repoFindById.mockResolvedValueOnce(tpl({ html: '<h1>Market Brief</h1>' }));

      expect(await service.getHtml('tpl-1')).toBe('<h1>Market Brief</h1>');
      expect(mocks.repoFindById).toHaveBeenCalledWith('tpl-1');
    });

    it('throws NotFound for a missing or soft-deleted template (the default lookup excludes deleted rows)', async () => {
      mocks.repoFindById.mockResolvedValueOnce(null);

      await expect(service.getHtml('tpl-1')).rejects.toThrow(InsightTemplateNotFoundError);
      // No includeDeleted opt-in: a soft-deleted row reads as missing.
      expect(mocks.repoFindById).toHaveBeenCalledWith('tpl-1');
    });
  });

  describe('InsightTemplateService.prepareForMessage', () => {
    const TEMPLATE_ID = '00000000-0000-0000-0000-00000000e001';
    const prepare = () => service.prepareForMessage({ id: TEMPLATE_ID, name: 'Market Brief' });

    it('returns a text block carrying the template HTML and its id', async () => {
      mocks.repoFindById.mockResolvedValueOnce(
        tpl({ id: TEMPLATE_ID, name: 'Market Brief', html: '<section data-section="summary"></section>' }),
      );

      const block = await prepare();

      expect(mocks.repoFindById).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(block.type).toBe('text');
      expect(block.text).toContain(`<insight_template id="${TEMPLATE_ID}" name="Market Brief">`);
      expect(block.text).toContain('<section data-section="summary"></section>');
      expect(block.text).not.toContain('status="missing"');
    });

    it('returns a missing block for a soft-deleted template without opting into deleted rows', async () => {
      mocks.repoFindById.mockResolvedValueOnce(null);

      expect((await prepare()).text).toContain('status="missing"');
      expect(mocks.repoFindById).toHaveBeenCalledWith(TEMPLATE_ID);
    });

    it('returns an outline and the handoff rule, not the HTML, for a template over the chat inline cap', async () => {
      const body = `<section data-section="summary"><h2>Summary</h2>${'x'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS)}</section>`;
      mocks.repoFindById.mockResolvedValueOnce(tpl({ id: TEMPLATE_ID, name: 'Market Brief', html: body }));

      const { text } = await prepare();

      expect(text).toContain('status="too-large-for-chat"');
      expect(text).toContain('propose_workforce_handoff');
      expect(text).not.toContain('<template_html>');
      expect(text).not.toContain('x'.repeat(2_000));
    });
  });

  describe('InsightTemplateService.readPartForWorkforce', () => {
    const TEMPLATE_ID = '00000000-0000-0000-0000-00000000e001';

    it('returns the requested part of the full HTML, however large the template', async () => {
      const html = 'a'.repeat(WORKFORCE_TEMPLATE_PART_CHARS) + 'b'.repeat(10);
      mocks.repoFindById.mockResolvedValueOnce(tpl({ id: TEMPLATE_ID, name: 'Market Brief', html }));

      const { text } = await service.readPartForWorkforce({ id: TEMPLATE_ID, name: 'Market Brief' }, 2);

      expect(mocks.repoFindById).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(text).toContain('part 2 of 2');
      expect(text).toContain('b'.repeat(10));
      expect(text).not.toContain('a'.repeat(10));
    });

    it('returns a missing block for a template that is gone', async () => {
      mocks.repoFindById.mockResolvedValueOnce(null);

      const { text } = await service.readPartForWorkforce({ id: TEMPLATE_ID, name: 'Market Brief' }, 1);

      expect(text).toContain('status="missing"');
    });
  });

  describe('InsightTemplateService.create', () => {
    it('inserts the trimmed row', async () => {
      const insertedRow = tpl({ id: 'tpl-new' });
      mocks.repoInsert.mockResolvedValueOnce(insertedRow);

      const result = await create({
        name: '  Html Template  ',
        description: '  A description  ',
        icon: 'scale',
        html: '<h1>Brief</h1>',
        userId: 'user-1',
      });

      expect(result).toEqual(insertedRow);
      expect(mocks.repoInsert).toHaveBeenCalledWith({
        name: 'Html Template',
        description: 'A description',
        icon: 'scale',
        html: '<h1>Brief</h1>',
        created_by: 'user-1',
      });
    });

    it('stores a missing icon as null', async () => {
      mocks.repoInsert.mockResolvedValueOnce(tpl());
      await create();
      expect(mocks.repoInsert).toHaveBeenCalledWith(expect.objectContaining({ icon: null }));
    });

    it.each([
      ['an empty/whitespace name', { name: '   ' }, InsightTemplateValidationError],
      ['a name over the insight name cap', { name: 'A'.repeat(MAX_INSIGHT_NAME_LENGTH + 1) }, InsightTemplateValidationError],
      ['missing html', { html: undefined as unknown as string }, InsightTemplateValidationError],
      ['whitespace-only html', { html: '  \n ' }, InsightTemplateValidationError],
      ['an unknown icon', { icon: 'rocket' }, InsightTemplateValidationError],
      ['html over the character cap', { html: OVERSIZED }, InsightTemplateTooLargeError],
    ])('rejects %s without inserting', async (_label, input, ErrorType) => {
      await expect(create(input)).rejects.toThrow(ErrorType);
      expect(mocks.repoInsert).not.toHaveBeenCalled();
    });

    it('accepts html exactly at the character cap', async () => {
      mocks.repoInsert.mockResolvedValueOnce(tpl());
      await expect(create({ html: 'x'.repeat(INSIGHT_TEMPLATE_MAX_CHARS) })).resolves.toBeDefined();
    });

    it('measures the cap in characters, not UTF-8 bytes', async () => {
      // 3 bytes per character: over the cap in bytes, within it in characters.
      mocks.repoInsert.mockResolvedValueOnce(tpl());
      await expect(create({ html: '€'.repeat(INSIGHT_TEMPLATE_MAX_CHARS) })).resolves.toBeDefined();
    });

    it('reports the real size in the too-large message', async () => {
      await expect(create({ html: 'x'.repeat(285_000) })).rejects.toThrow(
        'Template is 285,000 characters; templates are limited to 250,000.',
      );
    });

    it('does not offer the sample-data alternative on an upload', async () => {
      const error = await create({ html: 'x'.repeat(285_000) }).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(SAVE_AS_TEMPLATE_TOO_LARGE_HINT);
    });
  });

  describe('InsightTemplateService.createFromInsight', () => {
    it('inserts the insight HTML under the given name', async () => {
      const insertedRow = tpl({ id: 'tpl-insight-1' });
      mocks.repoInsert.mockResolvedValueOnce(insertedRow);

      const result = await service.createFromInsight({
        name: 'Report Template',
        description: 'Test description',
        html: '<html><body>Hello</body></html>',
        userId: 'u-1',
      });

      expect(result).toEqual(insertedRow);
      expect(mocks.repoInsert).toHaveBeenCalledWith({
        name: 'Report Template',
        description: 'Test description',
        html: '<html><body>Hello</body></html>',
        created_by: 'u-1',
      });
    });

    it.each([
      ['keeps the name unchanged when no collision', '  My New Template  ', 'My New Template'],
      [
        'appends the duplicateInsightName suffix when a template with that name exists',
        'Existing Template',
        'Existing Template (copy)',
      ],
    ])('%s', async (_label, name, expectedName) => {
      mocks.repoList.mockResolvedValueOnce([tpl({ name: 'Existing Template' })]);
      mocks.repoInsert.mockResolvedValueOnce({ id: 'tpl-2' });

      await service.createFromInsight({ name, html: '<p>content</p>' });

      expect(mocks.repoInsert).toHaveBeenCalledWith(expect.objectContaining({ name: expectedName }));
    });

    it.each([
      ['a blank name', { name: '   ', html: '<p>content</p>' }, InsightTemplateValidationError],
      ['empty html', { name: 'Valid Name', html: '' }, InsightTemplateValidationError],
      ['html over the character cap', { name: 'Valid Name', html: OVERSIZED }, InsightTemplateTooLargeError],
    ])('rejects %s without inserting', async (_label, input, ErrorType) => {
      await expect(service.createFromInsight(input)).rejects.toThrow(ErrorType);
      expect(mocks.repoInsert).not.toHaveBeenCalled();
    });

    it('points an oversized insight at the sample-data alternative', async () => {
      await expect(
        service.createFromInsight({ name: 'Valid Name', html: 'x'.repeat(285_000) }),
      ).rejects.toThrow(
        `Template is 285,000 characters; templates are limited to 250,000. ${SAVE_AS_TEMPLATE_TOO_LARGE_HINT}`,
      );
    });
  });

  describe('InsightTemplateService.delete', () => {
    it('soft-deletes and returns the row', async () => {
      const existing = tpl();
      mocks.repoSoftDelete.mockResolvedValueOnce(existing);

      expect(await service.delete('tpl-1')).toEqual(existing);
      expect(mocks.repoSoftDelete).toHaveBeenCalledWith('tpl-1');
      expect(mocks.repoHardDelete).not.toHaveBeenCalled();
    });

    it('throws NotFound for a missing, already-deleted or other-workspace id', async () => {
      mocks.repoSoftDelete.mockResolvedValueOnce(null);
      await expect(service.delete('missing-id')).rejects.toThrow(InsightTemplateNotFoundError);
    });
  });

  describe('InsightTemplateService.restore', () => {
    it('restores a soft-deleted template', async () => {
      const row = tpl();
      mocks.repoRestore.mockResolvedValueOnce(row);

      expect(await service.restore('tpl-1')).toEqual(row);
      expect(mocks.repoRestore).toHaveBeenCalledWith('tpl-1');
    });

    it('throws NotFound when nothing deleted matches', async () => {
      mocks.repoRestore.mockResolvedValueOnce(null);
      await expect(service.restore('tpl-1')).rejects.toThrow(InsightTemplateNotFoundError);
    });
  });

  describe('InsightTemplateService.deletePermanently', () => {
    it('hard-deletes the template', async () => {
      const row = tpl();
      mocks.repoHardDelete.mockResolvedValueOnce(row);

      expect(await service.deletePermanently('tpl-1')).toEqual(row);
      expect(mocks.repoHardDelete).toHaveBeenCalledWith('tpl-1');
      expect(mocks.repoSoftDelete).not.toHaveBeenCalled();
    });

    it('throws NotFound when no row matches', async () => {
      mocks.repoHardDelete.mockResolvedValueOnce(null);
      await expect(service.deletePermanently('tpl-1')).rejects.toThrow(InsightTemplateNotFoundError);
    });
  });

  describe('InsightTemplateService.list', () => {
    it('merges each template\'s usage count from one grouped query', async () => {
      mocks.repoList.mockResolvedValueOnce([
        tpl({ id: 'tpl-1' }),
        tpl({ id: 'tpl-2' }),
        tpl({ id: 'tpl-3' }),
      ]);
      mocks.countBySourceTemplate.mockResolvedValueOnce([
        { template_id: 'tpl-3', usage_count: 4 },
        { template_id: 'tpl-1', usage_count: 1 },
        // A template no longer in the live library (soft-deleted) is ignored.
        { template_id: 'tpl-gone', usage_count: 9 },
      ]);

      const result = await service.list();

      expect(result.map((t) => [t.id, t.usage_count])).toEqual([
        ['tpl-1', 1],
        ['tpl-2', 0],
        ['tpl-3', 4],
      ]);
      expect(mocks.countBySourceTemplate).toHaveBeenCalledTimes(1);
      expect(mocks.countBySourceTemplate).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('gives every template a usage count of 0 when no insight came from one', async () => {
      mocks.repoList.mockResolvedValueOnce([tpl({ id: 'tpl-1' }), tpl({ id: 'tpl-2' })]);
      mocks.countBySourceTemplate.mockResolvedValueOnce([]);

      const result = await service.list();

      expect(result.map((t) => t.usage_count)).toEqual([0, 0]);
    });

    it('returns [] for an empty library', async () => {
      expect(await service.list()).toEqual([]);
    });
  });

  describe('InsightTemplateService.listDeleted', () => {
    it('returns the repository listing of deleted templates', async () => {
      const rows = [tpl({ deleted_at: '2026-09-24T00:00:00Z' })];
      mocks.repoListDeleted.mockResolvedValueOnce(rows);
      expect(await service.listDeleted()).toEqual(rows);
    });
  });

  describe('InsightTemplateService.update', () => {
    it('trims name and description and writes patch', async () => {
      const updatedRow = tpl({ name: 'Updated Name', description: 'Updated Description', icon: 'briefcase' });
      mocks.repoUpdate.mockResolvedValueOnce(updatedRow);

      const result = await service.update('tpl-1', {
        name: '  Updated Name  ',
        description: '  Updated Description  ',
        icon: 'briefcase',
      });

      expect(result).toEqual(updatedRow);
      expect(mocks.repoUpdate).toHaveBeenCalledWith('tpl-1', {
        name: 'Updated Name',
        description: 'Updated Description',
        icon: 'briefcase',
      });
    });

    it.each([
      ['converts empty description to null', { description: '   ' }, { description: null }],
      ['accepts null icon', { icon: null }, { icon: null }],
      ['only includes keys that were supplied by caller', { name: 'Only Name' }, { name: 'Only Name' }],
    ])('%s', async (_label, input, expected) => {
      mocks.repoUpdate.mockResolvedValueOnce({ id: 'tpl-1' });
      await service.update('tpl-1', input);
      expect(mocks.repoUpdate).toHaveBeenCalledWith('tpl-1', expected);
    });

    it('replaces the html', async () => {
      mocks.repoUpdate.mockResolvedValueOnce({ id: 'tpl-1' });

      await service.update('tpl-1', { html: '<p>v2</p>' });

      expect(mocks.repoUpdate).toHaveBeenCalledWith('tpl-1', { html: '<p>v2</p>' });
    });

    it('drops keys outside the patchable set', async () => {
      mocks.repoUpdate.mockResolvedValueOnce({ id: 'tpl-1' });

      await service.update('tpl-1', { name: 'N', deleted_at: null } as never);

      expect(mocks.repoUpdate).toHaveBeenCalledWith('tpl-1', { name: 'N' });
    });

    it.each([
      ['an empty name', { name: '   ' }],
      ['a name over the insight name cap', { name: 'A'.repeat(MAX_INSIGHT_NAME_LENGTH + 1) }],
      ['an invalid icon', { icon: 'invalid-icon' }],
      ['blank html', { html: '  ' }],
      ['non-string html', { html: 42 as unknown as string }],
    ])('rejects %s with InsightTemplateValidationError', async (_label, input) => {
      await expect(service.update('tpl-1', input)).rejects.toThrow(InsightTemplateValidationError);
      expect(mocks.repoUpdate).not.toHaveBeenCalled();
    });

    it('rejects html over the character cap with InsightTemplateTooLargeError', async () => {
      await expect(service.update('tpl-1', { html: OVERSIZED })).rejects.toThrow(
        InsightTemplateTooLargeError,
      );
      expect(mocks.repoUpdate).not.toHaveBeenCalled();
    });

    it('throws InsightTemplateNotFoundError when template does not exist', async () => {
      mocks.repoUpdate.mockResolvedValueOnce(null);
      await expect(service.update('non-existent', { name: 'New Name' })).rejects.toThrow(
        InsightTemplateNotFoundError,
      );
    });
  });

  describe('InsightTemplateService.duplicate', () => {
    const source = tpl({
      id: 'tpl-src',
      name: 'Market Brief',
      description: 'Market overview',
      icon: 'chart-line',
      html: '<h1>Market Brief</h1>',
      created_by: 'original-user',
    });

    it('inserts a copy under a suffixed name', async () => {
      mocks.repoFindById.mockResolvedValueOnce(source);
      mocks.repoList.mockResolvedValueOnce([source]);
      const duplicated = { ...source, id: 'tpl-dup', name: 'Market Brief (copy)' };
      mocks.repoInsert.mockResolvedValueOnce(duplicated);

      expect(await service.duplicate('tpl-src', 'user-2')).toEqual(duplicated);
      expect(mocks.repoFindById).toHaveBeenCalledWith('tpl-src');
      expect(mocks.repoInsert).toHaveBeenCalledWith({
        name: 'Market Brief (copy)',
        description: 'Market overview',
        icon: 'chart-line',
        html: '<h1>Market Brief</h1>',
        created_by: 'user-2',
      });
    });

    it('throws InsightTemplateNotFoundError when the source is missing or soft-deleted', async () => {
      mocks.repoFindById.mockResolvedValueOnce(null);

      await expect(service.duplicate('missing-id', 'user-1')).rejects.toThrow(InsightTemplateNotFoundError);
      expect(mocks.repoInsert).not.toHaveBeenCalled();
    });

    it('rejects a source whose html is over the character cap', async () => {
      mocks.repoFindById.mockResolvedValueOnce({ ...source, html: OVERSIZED });

      await expect(service.duplicate('tpl-src', 'user-1')).rejects.toThrow(InsightTemplateTooLargeError);
      expect(mocks.repoInsert).not.toHaveBeenCalled();
    });
  });
});
