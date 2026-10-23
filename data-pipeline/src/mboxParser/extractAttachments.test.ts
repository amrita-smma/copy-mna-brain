import { describe, it, expect } from 'vitest';
import { parseHeaders } from './parser';
import {
  extractAttachments,
  ATTACHMENT_MIN_BYTES,
  ATTACHMENT_MAX_BYTES,
} from './parser';
import type { Headers } from './parser';

// Build a minimal base64 body of a given decoded byte length.
// base64(N bytes) = ceil(N/3)*4 chars, but we approximate: N*4/3 encoded chars → N decoded bytes.
function makeBase64Body(decodedBytes: number): string {
  const buf = Buffer.alloc(decodedBytes, 0x41); // fill with 'A'
  return buf.toString('base64');
}

function buildMultipartMessage(attachmentBody: string, mimeType: string, filename: string): {
  headers: Headers;
  rawBody: string;
} {
  const boundary = 'TEST_BOUNDARY_001';
  const headers = parseHeaders(
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\nMime-Version: 1.0`,
  );
  const rawBody = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    `Hello`,
    `--${boundary}`,
    `Content-Type: ${mimeType}; name="${filename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${filename}"`,
    ``,
    attachmentBody,
    `--${boundary}--`,
  ].join('\r\n');
  return { headers, rawBody };
}

const VALID_PDF_BODY = makeBase64Body(ATTACHMENT_MIN_BYTES + 1000);

describe('extractAttachments', () => {
  it('returns one row for a qualifying PDF attachment', () => {
    const { headers, rawBody } = buildMultipartMessage(
      VALID_PDF_BODY,
      'application/pdf',
      'report.pdf',
    );
    const metas = extractAttachments(headers, rawBody);
    expect(metas).toHaveLength(1);
    expect(metas[0].mime_type).toBe('application/pdf');
    expect(metas[0].filename).toBe('report.pdf');
    expect(metas[0].encoding).toBe('base64');
    expect(typeof metas[0].content_hash).toBe('string');
    expect(metas[0].content_hash).toHaveLength(64); // sha256 hex
  });

  it('keeps a filename with a literal % instead of throwing URI malformed', () => {
    const { headers, rawBody } = buildMultipartMessage(
      VALID_PDF_BODY,
      'application/pdf',
      'Fee 2% final.pdf',
    );
    const metas = extractAttachments(headers, rawBody);
    expect(metas).toHaveLength(1);
    expect(metas[0].filename).toBe('Fee 2% final.pdf');
  });

  it('still percent-decodes an encoded filename', () => {
    const { headers, rawBody } = buildMultipartMessage(
      VALID_PDF_BODY,
      'application/pdf',
      'Q3%20report.pdf',
    );
    const metas = extractAttachments(headers, rawBody);
    expect(metas[0].filename).toBe('Q3 report.pdf');
  });

  it('skips non-attachment inline parts', () => {
    const boundary = 'BOUND';
    const headers = parseHeaders(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const rawBody = [
      `--${boundary}`,
      `Content-Type: text/plain`,
      `Content-Disposition: inline`,
      ``,
      `Hello`,
      `--${boundary}--`,
    ].join('\r\n');
    expect(extractAttachments(headers, rawBody)).toHaveLength(0);
  });

  it('skips disallowed MIME types (image/png)', () => {
    const { headers, rawBody } = buildMultipartMessage(
      VALID_PDF_BODY,
      'image/png',
      'logo.png',
    );
    expect(extractAttachments(headers, rawBody)).toHaveLength(0);
  });

  it('skips undersized attachments (< MIN_BYTES)', () => {
    const tinyBody = makeBase64Body(100); // well below 20 KB
    const { headers, rawBody } = buildMultipartMessage(
      tinyBody,
      'application/pdf',
      'tiny.pdf',
    );
    expect(extractAttachments(headers, rawBody)).toHaveLength(0);
  });

  it('skips oversized attachments (> MAX_BYTES)', () => {
    const hugeBody = makeBase64Body(MAX_BYTES + 1);
    const { headers, rawBody } = buildMultipartMessage(
      hugeBody,
      'application/pdf',
      'huge.pdf',
    );
    expect(extractAttachments(headers, rawBody)).toHaveLength(0);
  });

  it('returns deterministic content_hash across calls', () => {
    const { headers, rawBody } = buildMultipartMessage(
      VALID_PDF_BODY,
      'application/pdf',
      'stable.pdf',
    );
    const first = extractAttachments(headers, rawBody);
    const second = extractAttachments(headers, rawBody);
    expect(first[0].content_hash).toBe(second[0].content_hash);
  });

  it('accepts DOCX MIME type', () => {
    const { headers, rawBody } = buildMultipartMessage(
      VALID_PDF_BODY,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc.docx',
    );
    const metas = extractAttachments(headers, rawBody);
    expect(metas).toHaveLength(1);
    expect(metas[0].mime_type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});

const MAX_BYTES = ATTACHMENT_MAX_BYTES;
