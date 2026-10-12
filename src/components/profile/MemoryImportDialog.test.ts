import { describe, it, expect } from 'vitest';
import { rejectFileReason } from './MemoryImportDialog';

/** A `File` stand-in; `rejectFileReason` only reads `name` and `size`. */
const file = (name: string, size = 1024) => ({ name, size }) as File;

const MB = 1024 * 1024;

describe('rejectFileReason', () => {
  it('accepts the kinds the server can extract text from', () => {
    for (const name of ['notes.pdf', 'memo.doc', 'memo.docx', 'notes.txt', 'notes.md']) {
      expect(rejectFileReason(file(name)), name).toBeNull();
    }
  });

  it('accepts them whatever the case of the extension', () => {
    expect(rejectFileReason(file('IC_Notes.PDF'))).toBeNull();
    expect(rejectFileReason(file('Memo.DocX'))).toBeNull();
  });

  it('rejects a kind the server cannot read', () => {
    // Dragging bypasses the picker's `accept` filter entirely, so without this
    // a drop would be laxer than a click and only fail after the upload.
    const reason = rejectFileReason(file('screenshot.png'));

    expect(reason).toContain('screenshot.png');
    expect(reason).toContain('PDF, Word file, or plain text');
  });

  it('rejects a file with no extension at all', () => {
    expect(rejectFileReason(file('notes'))).not.toBeNull();
  });

  it('is not fooled by the extension appearing mid-name', () => {
    expect(rejectFileReason(file('my.pdf.exe'))).not.toBeNull();
  });

  it('rejects a file past the size the server accepts', () => {
    const reason = rejectFileReason(file('huge.pdf', 10 * MB + 1));

    expect(reason).toContain('huge.pdf');
    expect(reason).toContain('10MB');
  });

  it('accepts one exactly at the limit', () => {
    expect(rejectFileReason(file('big.pdf', 10 * MB))).toBeNull();
  });

  it('checks the kind before the size, so the clearer problem is reported', () => {
    expect(rejectFileReason(file('huge.png', 50 * MB))).toContain('not a kind of file');
  });
});
