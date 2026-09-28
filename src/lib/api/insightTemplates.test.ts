import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MAX_TEMPLATE_CHARS,
  uploadInsightTemplate,
  isValidTemplateExtension,
  validateTemplateFile,
  getInsightTemplateHtml,
  listInsightTemplates,
  listDeletedInsightTemplates,
  deleteInsightTemplate,
  deleteInsightTemplatePermanently,
  restoreInsightTemplate,
  replaceInsightTemplateHtml,
} from './insightTemplates';
import { INSIGHT_TEMPLATE_MAX_CHARS } from '@/lib/insights/templateAttachment';

function stubFetch(data: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status,
    text: async () => JSON.stringify({ data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isValidTemplateExtension', () => {
  it('accepts .html, case-insensitively', () => {
    expect(isValidTemplateExtension('report.html')).toBe(true);
    expect(isValidTemplateExtension('report.HTML')).toBe(true);
  });

  it('rejects the previously-allowed PDF/DOCX extensions and anything else', () => {
    expect(isValidTemplateExtension('report.pdf')).toBe(false);
    expect(isValidTemplateExtension('report.docx')).toBe(false);
    expect(isValidTemplateExtension('report.txt')).toBe(false);
  });
});

describe('validateTemplateFile', () => {
  const html = (text: string, name = 'report.html') => new File([text], name, { type: 'text/html' });

  it('uses the same character cap as the server', () => {
    expect(MAX_TEMPLATE_CHARS).toBe(INSIGHT_TEMPLATE_MAX_CHARS);
    expect(MAX_TEMPLATE_CHARS).toBe(250_000);
  });

  it('returns an error for a non-HTML file', async () => {
    const file = new File(['<p>x</p>'], 'report.pdf', { type: 'application/pdf' });
    expect(await validateTemplateFile(file)).toEqual({
      ok: false,
      error: 'Invalid file type. Only HTML files are supported.',
    });
  });

  it('returns an error for an empty or whitespace-only file', async () => {
    expect(await validateTemplateFile(html(''))).toEqual({ ok: false, error: 'The file is empty.' });
    expect(await validateTemplateFile(html('  \n'))).toEqual({ ok: false, error: 'The file is empty.' });
  });

  it('reads the text and rejects it with the real size when over the character cap', async () => {
    expect(await validateTemplateFile(html('x'.repeat(285_000)))).toEqual({
      ok: false,
      error: 'Template is 285,000 characters; templates are limited to 250,000.',
    });
  });

  it('counts characters, not bytes: a multi-byte file under the cap is accepted', async () => {
    const text = '€'.repeat(MAX_TEMPLATE_CHARS);
    const file = html(text);
    expect(file.size).toBeGreaterThan(MAX_TEMPLATE_CHARS);

    expect(await validateTemplateFile(file)).toEqual({ ok: true, html: text });
  });

  it('rejects a file too many bytes to possibly fit without reading it', async () => {
    const file = html('<p>x</p>');
    Object.defineProperty(file, 'size', { value: MAX_TEMPLATE_CHARS * 3 + 1 });
    const textSpy = vi.spyOn(file, 'text');

    const result = await validateTemplateFile(file);

    expect(result.ok).toBe(false);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('returns the html for a valid file', async () => {
    expect(await validateTemplateFile(html('<p>x</p>'))).toEqual({ ok: true, html: '<p>x</p>' });
  });
});

describe('uploadInsightTemplate', () => {
  it('posts the html with the name, description and icon in one request', async () => {
    const created = { id: 'tpl-1', name: 'Market Brief' };
    const fetchMock = stubFetch(created, 201);

    expect(
      await uploadInsightTemplate({
        name: 'Market Brief',
        description: 'Brief',
        icon: 'scale',
        html: '<h1>Brief</h1>',
      }),
    ).toEqual(created);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/insight-templates');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'Market Brief',
      description: 'Brief',
      icon: 'scale',
      html: '<h1>Brief</h1>',
    });
  });

  it('sends null for a missing description and icon', async () => {
    const fetchMock = stubFetch({ id: 'tpl-1' }, 201);

    await uploadInsightTemplate({ name: 'Market Brief', html: '<h1>Brief</h1>' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: 'Market Brief',
      description: null,
      icon: null,
      html: '<h1>Brief</h1>',
    });
  });
});

describe('listInsightTemplates', () => {
  it('returns the library with each template\'s usage_count', async () => {
    const rows = [
      { id: 'tpl-1', name: 'Brief', usage_count: 3 },
      { id: 'tpl-2', name: 'Memo', usage_count: 0 },
    ];
    const fetchMock = stubFetch(rows);

    const result = await listInsightTemplates();

    expect(result.map((t) => t.usage_count)).toEqual([3, 0]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/insight-templates');
  });
});

describe('getInsightTemplateHtml', () => {
  it('unwraps { data: { html } } into the html string', async () => {
    const fetchMock = stubFetch({ html: '<h1>Market Brief</h1>' });

    expect(await getInsightTemplateHtml('tpl-1')).toBe('<h1>Market Brief</h1>');
    expect(fetchMock).toHaveBeenCalledWith('/api/insight-templates/tpl-1', expect.anything());
  });
});

describe('soft delete client functions', () => {
  it('listDeletedInsightTemplates asks for ?deleted=true', async () => {
    const fetchMock = stubFetch([]);
    await listDeletedInsightTemplates();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/insight-templates?deleted=true');
  });

  it('deleteInsightTemplate soft-deletes with a plain DELETE', async () => {
    const fetchMock = stubFetch({ id: 'tpl-1' });
    await deleteInsightTemplate('tpl-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/insight-templates/tpl-1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('deleteInsightTemplatePermanently sends ?permanent=true', async () => {
    const fetchMock = stubFetch({ id: 'tpl-1' });
    await deleteInsightTemplatePermanently('tpl-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/insight-templates/tpl-1?permanent=true');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('restoreInsightTemplate posts to /restore', async () => {
    const fetchMock = stubFetch({ id: 'tpl-1' });
    await restoreInsightTemplate('tpl-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/insight-templates/tpl-1/restore');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });
});

describe('replaceInsightTemplateHtml', () => {
  it('patches { html } onto the template', async () => {
    const fetchMock = stubFetch({ id: 'tpl-1' });
    await replaceInsightTemplateHtml('tpl-1', '<p>v3</p>');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/insight-templates/tpl-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ html: '<p>v3</p>' });
  });
});
