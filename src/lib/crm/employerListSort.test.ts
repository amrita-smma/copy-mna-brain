import { describe, it, expect } from 'vitest';
import { parseEmployerListSort } from './employerListSort';

describe('parseEmployerListSort', () => {
  it('defaults to latest contact first when nothing is given', () => {
    expect(parseEmployerListSort(null, null)).toEqual({ sort: 'last_contact', dir: 'desc' });
  });

  it('keeps a known sort and direction', () => {
    expect(parseEmployerListSort('name', 'desc')).toEqual({ sort: 'name', dir: 'desc' });
    expect(parseEmployerListSort('emails', 'asc')).toEqual({ sort: 'emails', dir: 'asc' });
  });

  it("takes the column's default direction when dir is missing or unknown", () => {
    expect(parseEmployerListSort('name', null)).toEqual({ sort: 'name', dir: 'asc' });
    expect(parseEmployerListSort('team_members', 'sideways')).toEqual({
      sort: 'team_members',
      dir: 'desc',
    });
  });

  it('falls back to the default sort for an unknown key', () => {
    expect(parseEmployerListSort('created_at; DROP TABLE users', 'asc')).toEqual({
      sort: 'last_contact',
      dir: 'asc',
    });
  });
});
