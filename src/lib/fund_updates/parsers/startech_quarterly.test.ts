import { describe, expect, it } from 'vitest';
import {
  resolveAppendixId,
  scoreAppendixNameMatch,
} from './startech_quarterly';

const APPENDIX = [
  { id: 'S017', name: 'Akulaku' },
  { id: 'S009', name: 'Gojek' },
  { id: 'S002', name: 'Air Bnb Inc' },
  { id: 'S001', name: 'Spotify Inc' },
  { id: 'S048', name: 'Mahogany (Coco)' },
  { id: 'S026', name: 'Metamask' },
  { id: 'S006', name: 'Alpha JWC 2' },
  { id: 'S023', name: 'Alpha JWC 3' },
  { id: 'S003', name: 'Alpha JWC 1' },
  { id: 'S015', name: 'Alto Pharmaceutical (Nahkoda Fund)' },
];

describe('scoreAppendixNameMatch', () => {
  it('scores exact and near-exact names highly', () => {
    expect(scoreAppendixNameMatch('Akulaku', 'Akulaku')).toBe(1);
    expect(scoreAppendixNameMatch('AirBnb', 'Air Bnb Inc')).toBeGreaterThanOrEqual(0.85);
    expect(scoreAppendixNameMatch('Coco', 'Mahogany (Coco)')).toBeGreaterThanOrEqual(0.85);
  });

  it('does not force a weak match for unrelated names', () => {
    expect(scoreAppendixNameMatch('GOTO Group', 'Gojek')).toBeLessThan(0.7);
  });
});

describe('resolveAppendixId', () => {
  it('uses manual overrides for awkward sheet codes', () => {
    expect(resolveAppendixId('GOTO', ['GOTO Group'], APPENDIX)).toBe('S009');
    expect(resolveAppendixId('AJWCII', ['Alpha JWC Fund II'], APPENDIX)).toBe('S006');
    expect(resolveAppendixId('AJWCIII', ['Alpha JWC Fund III'], APPENDIX)).toBe('S023');
  });

  it('fuzzy-matches Structure / sheet names when no override exists', () => {
    expect(resolveAppendixId('AKUL', ['AKUL', 'Akulaku'], APPENDIX)).toBe('S017');
    expect(resolveAppendixId('ABNB', ['ABNB', 'AirBnb', 'Airbnb'], APPENDIX)).toBe('S002');
    expect(resolveAppendixId('SPOT', ['SPOT', 'Spotify'], APPENDIX)).toBe('S001');
    expect(resolveAppendixId('COCO', ['COCO', 'Coco'], APPENDIX)).toBe('S048');
    expect(resolveAppendixId('META', ['META', 'Metmask'], APPENDIX)).toBe('S026');
    expect(resolveAppendixId('ALTO', ['ALTO', 'Alto Pharmaceutical'], APPENDIX)).toBe('S015');
  });

  it('returns undefined when nothing is confident', () => {
    expect(resolveAppendixId('EURO', ['EURO', 'PT Euro Medika', 'Euro Medika'], APPENDIX)).toBeUndefined();
    expect(resolveAppendixId('NEWX', ['Brand New Co'], APPENDIX)).toBeUndefined();
  });
});
