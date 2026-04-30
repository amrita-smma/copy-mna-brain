import { describe, expect, it } from 'vitest';
import { buildContentDisposition } from './s3';

describe('buildContentDisposition', () => {
  it('emits both ASCII fallback and RFC 5987 form for plain ASCII names', () => {
    const header = buildContentDisposition('report.pdf');
    expect(header).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('replaces non-ASCII chars in the ASCII fallback while preserving them in filename*', () => {
    const header = buildContentDisposition('文件.pdf');
    expect(header).toBe(
      `attachment; filename="__.pdf"; filename*=UTF-8''%E6%96%87%E4%BB%B6.pdf`,
    );
  });

  it('handles Korean filenames', () => {
    const header = buildContentDisposition('파일.pdf');
    expect(header).toBe(
      `attachment; filename="__.pdf"; filename*=UTF-8''%ED%8C%8C%EC%9D%BC.pdf`,
    );
  });

  it('preserves ASCII chars when mixed with non-ASCII', () => {
    const header = buildContentDisposition('quarterly_报告_q1.pdf');
    expect(header).toBe(
      `attachment; filename="quarterly____q1.pdf"; filename*=UTF-8''quarterly_%E6%8A%A5%E5%91%8A_q1.pdf`,
    );
  });

  it('escapes double quotes and backslashes in the ASCII fallback', () => {
    const header = buildContentDisposition('weird"name\\.pdf');
    expect(header).toBe(
      `attachment; filename="weird_name_.pdf"; filename*=UTF-8''weird%22name%5C.pdf`,
    );
  });

  it('encodes spaces in the RFC 5987 form', () => {
    const header = buildContentDisposition('my report.pdf');
    expect(header).toBe(
      `attachment; filename="my report.pdf"; filename*=UTF-8''my%20report.pdf`,
    );
  });
});
