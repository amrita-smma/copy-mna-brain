import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportSlidesToPptx, type SlideInput } from './slideExportService';

// Mock htmlToPptxElementsBatch so tests never launch a real browser
vi.mock('./htmlToPptxElements', () => ({
  htmlToPptxElementsBatch: vi.fn(async (htmls: string[]) =>
    htmls.map(() => [
      { type: 'rect', x: 0, y: 0, w: 13.33, h: 0.5, fill: '1E3A5F' },
      { type: 'text', x: 0, y: 0, w: 13.33, h: 0.5, text: 'Slide content', wrap: true },
    ])
  ),
}));

const mockAddShape = vi.fn();
const mockAddText = vi.fn();
const mockAddTable = vi.fn();
const mockAddSlide = vi.fn();
const mockWrite = vi.fn();

vi.mock('pptxgenjs', () => ({ default: vi.fn() }));

import PptxGenJS from 'pptxgenjs';
const MockedPptxGenJS = vi.mocked(PptxGenJS);

beforeEach(() => {
  vi.clearAllMocks();
  mockWrite.mockResolvedValue(new Uint8Array(Buffer.from('fake-pptx')));
  mockAddSlide.mockReturnValue({ addShape: mockAddShape, addText: mockAddText, addTable: mockAddTable });
  MockedPptxGenJS.mockImplementation(function (this: Record<string, unknown>) {
    this.layout = '';
    this.addSlide = mockAddSlide;
    this.write = mockWrite;
  } as never);
});

describe('exportSlidesToPptx', () => {
  it('returns a Buffer', async () => {
    const slides: SlideInput[] = [{ title: 'Slide 1', html: '<div>Hello</div>' }];
    expect(await exportSlidesToPptx(slides)).toBeInstanceOf(Buffer);
  });

  it('adds one PPTX slide per input slide', async () => {
    const slides: SlideInput[] = [
      { title: 'A', html: '<div>A</div>' },
      { title: 'B', html: '<div>B</div>' },
      { title: 'C', html: '<div>C</div>' },
    ];
    await exportSlidesToPptx(slides);
    expect(mockAddSlide).toHaveBeenCalledTimes(3);
  });

  it('returns an empty PPTX without opening a browser when slides is empty', async () => {
    const { htmlToPptxElementsBatch } = await import('./htmlToPptxElements');
    const result = await exportSlidesToPptx([]);
    expect(mockAddSlide).not.toHaveBeenCalled();
    expect(vi.mocked(htmlToPptxElementsBatch)).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Buffer);
  });

  it('uses LAYOUT_WIDE', async () => {
    let capturedLayout = '';
    MockedPptxGenJS.mockImplementation(function (this: Record<string, unknown>) {
      Object.defineProperty(this, 'layout', {
        set(v: string) { capturedLayout = v; },
        get() { return capturedLayout; },
        configurable: true,
      });
      this.addSlide = mockAddSlide;
      this.write = mockWrite;
    } as never);
    await exportSlidesToPptx([]);
    expect(capturedLayout).toBe('LAYOUT_WIDE');
  });

  it('calls addShape for rect elements', async () => {
    await exportSlidesToPptx([{ title: 'T', html: '<div/>' }]);
    expect(mockAddShape).toHaveBeenCalledWith('rect', expect.objectContaining({
      fill: expect.objectContaining({ color: '1E3A5F' }),
    }));
  });

  it('calls addText for text elements', async () => {
    await exportSlidesToPptx([{ title: 'T', html: '<div/>' }]);
    expect(mockAddText).toHaveBeenCalledWith('Slide content', expect.any(Object));
  });

  it('calls addTable for table elements', async () => {
    const { htmlToPptxElementsBatch } = await import('./htmlToPptxElements');
    vi.mocked(htmlToPptxElementsBatch).mockResolvedValueOnce([[
      {
        type: 'table', x: 0, y: 1, w: 10, h: 3,
        rows: [[{ text: 'Cell', bold: false }]],
      },
    ]]);
    await exportSlidesToPptx([{ title: 'T', html: '<div><table/></div>' }]);
    expect(mockAddTable).toHaveBeenCalled();
  });

  it('skips zero-size elements', async () => {
    const { htmlToPptxElementsBatch } = await import('./htmlToPptxElements');
    vi.mocked(htmlToPptxElementsBatch).mockResolvedValueOnce([[
      { type: 'rect', x: 0, y: 0, w: 0, h: 0, fill: 'FF0000' },
    ]]);
    await exportSlidesToPptx([{ title: 'T', html: '<div/>' }]);
    expect(mockAddShape).not.toHaveBeenCalled();
  });
});
