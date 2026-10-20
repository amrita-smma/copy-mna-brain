import { describe, expect, it } from 'vitest';
import {
  FEATURED_SLIDE_ACCEPT,
  detectFileKind,
  isFeaturableFileKind,
  isMediaFileKind,
  isPresentableFileKind,
} from './fileType';

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
    ['pitch.mp4', 'video'],
    ['screen-recording.mov', 'video'],
    ['clip.webm', 'video'],
    ['call.mp3', 'audio'],
    ['voice-memo.m4a', 'audio'],
    ['interview.wav', 'audio'],
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
    expect(isPresentableFileKind('video')).toBe(true);
    expect(isPresentableFileKind('audio')).toBe(true);
  });

  it('is false for "unknown"', () => {
    expect(isPresentableFileKind('unknown')).toBe(false);
  });
});

describe('isMediaFileKind', () => {
  it('is true only for video and audio', () => {
    expect(isMediaFileKind('video')).toBe(true);
    expect(isMediaFileKind('audio')).toBe(true);
    expect(isMediaFileKind('pdf')).toBe(false);
    expect(isMediaFileKind('unknown')).toBe(false);
  });
});

describe('isFeaturableFileKind', () => {
  it('accepts decks and recordings', () => {
    expect(isFeaturableFileKind('pdf')).toBe(true);
    expect(isFeaturableFileKind('pptx')).toBe(true);
    expect(isFeaturableFileKind('video')).toBe(true);
    expect(isFeaturableFileKind('audio')).toBe(true);
  });

  it('rejects documents, images and unknown files', () => {
    expect(isFeaturableFileKind('docx')).toBe(false);
    expect(isFeaturableFileKind('image')).toBe(false);
    expect(isFeaturableFileKind('unknown')).toBe(false);
  });
});

describe('FEATURED_SLIDE_ACCEPT', () => {
  it('lists the deck types plus every media extension', () => {
    const accepted = FEATURED_SLIDE_ACCEPT.split(',');
    expect(accepted).toEqual(expect.arrayContaining(['.pdf', '.pptx', 'video/*', 'audio/*', '.mp4', '.mov', '.mp3', '.m4a']));
    expect(accepted).not.toContain('.docx');
  });
});
