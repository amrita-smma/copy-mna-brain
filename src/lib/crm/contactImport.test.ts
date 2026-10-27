import { describe, it, expect } from 'vitest';
import {
  chunkRows,
  collapseByEmail,
  fieldForHeader,
  normalizeEmail,
  parseContactCsv,
  parseCsv,
  sanitizeImportRows,
} from './contactImport';

describe('parseCsv', () => {
  it('handles quoted fields with commas, escaped quotes, newlines, CRLF and a BOM', () => {
    const text = '﻿name,bio\r\n"Doe, Jane","Says ""hi""\ntwice"\r\n\r\nBob,\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'bio'],
      ['Doe, Jane', 'Says "hi"\ntwice'],
      ['Bob', ''],
    ]);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases, returning undefined when blank', () => {
    expect(normalizeEmail('  Jane@Bank.COM ')).toBe('jane@bank.com');
    expect(normalizeEmail('   ')).toBeUndefined();
    expect(normalizeEmail(null)).toBeUndefined();
  });
});

describe('parseContactCsv', () => {
  it('maps common header spellings onto contact fields', () => {
    const out = parseContactCsv(
      'Full Name,Company,E-mail Address,Job Title,LinkedIn\nJane Doe,Goldman Sachs,Jane@GS.com,MD,https://li/jane\n',
    );
    expect(out.errors).toEqual([]);
    expect(out.mappedHeaders).toMatchObject({
      name: 'Full Name',
      firm: 'Company',
      email: 'E-mail Address',
      title: 'Job Title',
      linkedinUrl: 'LinkedIn',
    });
    expect(out.rows).toEqual([
      {
        name: 'Jane Doe',
        firm: 'Goldman Sachs',
        email: 'jane@gs.com',
        title: 'MD',
        linkedinUrl: 'https://li/jane',
      },
    ]);
  });

  it('builds the name from first/last name columns when there is no name column', () => {
    const out = parseContactCsv('First Name,Last Name,Email\nJane,Doe,j@x.com\n');
    expect(out.rows).toEqual([{ name: 'Jane Doe', email: 'j@x.com' }]);
  });

  it('rejects a file with no name column at all', () => {
    const out = parseContactCsv('Email,Company\nj@x.com,X\n');
    expect(out.rows).toEqual([]);
    expect(out.errors[0]).toMatch(/Name/);
  });

  it('reports bad rows by their CSV line number and keeps the good ones', () => {
    const out = parseContactCsv('Name,Email\nJane,jane@x.com\n,nobody@x.com\nBob,not-an-email\n');
    expect(out.rows).toEqual([{ name: 'Jane', email: 'jane@x.com' }]);
    expect(out.errors).toEqual([
      'Row 3: name is required.',
      'Row 4: "not-an-email" is not a valid email.',
    ]);
  });

  it('reports an empty file', () => {
    expect(parseContactCsv('').errors).toEqual(['The file is empty.']);
  });

  it('skips a banner above the header row and numbers rows from the top of the file', () => {
    const out = parseContactCsv(
      '"© Vendor Ltd 2026. All rights reserved."\nName,Email\nJane,jane@x.com\nBob,not-an-email\n',
    );
    expect(out.mappedHeaders).toMatchObject({ name: 'Name', email: 'Email' });
    expect(out.extraHeaders).toEqual([]);
    expect(out.rows).toEqual([{ name: 'Jane', email: 'jane@x.com' }]);
    expect(out.errors).toEqual(['Row 4: "not-an-email" is not a valid email.']);
  });

  it('treats placeholder cells like "-" and "N/A" as blank', () => {
    const out = parseContactCsv('Name,Email,LinkedIn,City\nJane,-,—,N/A\n');
    expect(out.errors).toEqual([]);
    expect(out.rows).toEqual([{ name: 'Jane' }]);
  });
});

describe('sanitizeImportRows', () => {
  it('drops unknown keys and non-string values from an untrusted body', () => {
    const { rows } = sanitizeImportRows([
      { name: ' A ', email: 'A@B.com', origin: 'auto', employer_id: 'e1', phone: 123 },
    ]);
    expect(rows).toEqual([{ name: 'A', email: 'a@b.com' }]);
  });

  it('rejects a non-array body', () => {
    expect(sanitizeImportRows({ name: 'A' }).errors).toEqual([
      'Expected a list of contacts.',
    ]);
  });
});

describe('fieldForHeader', () => {
  it('recognises common CRM-export spellings of the profile fields', () => {
    expect(fieldForHeader('LinkedIn Profile URL')).toBe('linkedinUrl');
    expect(fieldForHeader('Mobile Phone')).toBe('phone');
    expect(fieldForHeader('Designation')).toBe('title');
    expect(fieldForHeader('Account Name')).toBe('firm');
    expect(fieldForHeader('Division')).toBe('department');
    expect(fieldForHeader('Sector Coverage')).toBe('specialization');
    expect(fieldForHeader('Territory')).toBe('coverageRegion');
    expect(fieldForHeader('Remarks')).toBe('bio');
    expect(fieldForHeader('Favourite colour')).toBeNull();
  });
});

describe('parseContactCsv (extra columns)', () => {
  it('keeps unrecognised columns on the contact as "Header: value" lines in bio', () => {
    const out = parseContactCsv(
      'Name,Email,Notes,Location,Assistant\nJane,j@x.com,Met at conf,Seoul,\n',
    );
    expect(out.extraHeaders).toEqual(['Location', 'Assistant']);
    expect(out.rows[0].bio).toBe('Met at conf\nLocation: Seoul');
  });

  it('keeps a second phone column instead of dropping it', () => {
    const out = parseContactCsv('Name,Work Phone,Mobile\nJane,111,222\n');
    expect(out.rows[0]).toMatchObject({ phone: '111', bio: 'Mobile: 222' });
  });
});

describe('collapseByEmail', () => {
  it('folds repeated emails case-insensitively, later rows filling blanks', () => {
    const out = collapseByEmail([
      { name: 'A', email: 'a@x.com', phone: '1' },
      { name: 'B' },
      { name: 'A2', email: 'A@X.com', title: 'VP' },
    ]);
    expect(out.duplicates).toBe(1);
    expect(out.rows).toEqual([
      { name: 'A2', email: 'a@x.com', phone: '1', title: 'VP' },
      { name: 'B' },
    ]);
  });
});

describe('chunkRows', () => {
  it('splits into consecutive batches so a file of any size can be posted', () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkRows([], 2)).toEqual([]);
  });
});
