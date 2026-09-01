import { describe, expect, it } from 'vitest';
import { detectFileKind, isPresentableFileKind } from './fileType';

describe('detectFileKind', () => {
  it.each([
    ['deal-memo.pdf', 'pdf'],
    ['deck.pptx', 'pptx'],
    ['deck.ppt', 'pptx'],
    ['notes.docx', 'docx'],
    ['notes.doc', 'docx'],
    ['logo.png', 'image'],
    ['logo.jpg', 'image'],
    ['logo.jpeg', 'image'],
    ['readme.txt', 'text'],
    ['readme.md', 'markdown'],
  ])('classifies %s as %s', (fileName, expected) => {
    expect(detectFileKind(fileName)).toBe(expected);
  });

  it('is case-insensitive on the extension', () => {
    expect(detectFileKind('DECK.PPTX')).toBe('pptx');
  });

  it('returns "unknown" for an unsupported extension', () => {
    expect(detectFileKind('workbook.xlsx')).toBe('unknown');
  });

  it('returns "unknown" for a name with no extension', () => {
    expect(detectFileKind('README')).toBe('unknown');
  });

  it('uses the last segment for a multi-dot name', () => {
    expect(detectFileKind('archive.tar.md')).toBe('markdown');
  });
});

describe('isPresentableFileKind', () => {
  it('is true for every kind except "unknown"', () => {
    expect(isPresentableFileKind('pdf')).toBe(true);
    expect(isPresentableFileKind('pptx')).toBe(true);
    expect(isPresentableFileKind('docx')).toBe(true);
    expect(isPresentableFileKind('image')).toBe(true);
    expect(isPresentableFileKind('text')).toBe(true);
    expect(isPresentableFileKind('markdown')).toBe(true);
  });

  it('is false for "unknown"', () => {
    expect(isPresentableFileKind('unknown')).toBe(false);
  });
});
