import { describe, expect, it } from 'vitest';
import { FEATURE_CATALOG, featureEnvDefault } from './catalog';

describe('FEATURE_CATALOG', () => {
  it('has no duplicate feature keys', () => {
    const keys = FEATURE_CATALOG.map((feature) => feature.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses SCREAMING_SNAKE_CASE keys so each doubles as an env-var name', () => {
    for (const feature of FEATURE_CATALOG) {
      expect(feature.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('gives every feature a non-empty label and description', () => {
    for (const feature of FEATURE_CATALOG) {
      expect(feature.label.trim()).not.toBe('');
      expect(feature.description.trim()).not.toBe('');
    }
  });

  it('registers Smart Files as a nav feature under SMART_FILES_ENABLED', () => {
    // Guards the "AI File Dump" → "Smart Files" rename: this key must stay in
    // sync with the `flag` field on SidebarPagesNav's Smart Files nav entry and
    // with the feature_flags rows migrated in
    // 20260810000000_rename_ai_file_dump_flag_to_smart_files.sql.
    const smartFiles = FEATURE_CATALOG.find((feature) => feature.key === 'SMART_FILES_ENABLED');
    expect(smartFiles).toBeDefined();
    expect(smartFiles?.label).toBe('Smart Files');
    expect(smartFiles?.navItem).toBe(true);
    expect(smartFiles?.defaultEnabled).toBe(true);
  });

  it('registers Meeting Intelligence as an opt-in, off-by-default general feature', () => {
    const meetings = FEATURE_CATALOG.find((feature) => feature.key === 'MEETING_INTELLIGENCE_ENABLED');
    expect(meetings).toBeDefined();
    expect(meetings?.defaultEnabled).toBe(false);
    expect(meetings?.navItem).toBe(false);
    expect(meetings?.category ?? 'general').toBe('general');
  });

  it('registers Fund Vehicle View under FUND_VEHICLE_VIEW_ENABLED with funds category and default on', () => {
    const fundVehicle = FEATURE_CATALOG.find((feature) => feature.key === 'FUND_VEHICLE_VIEW_ENABLED');
    expect(fundVehicle).toBeDefined();
    expect(fundVehicle?.label).toBe('Fund Vehicle View');
    expect(fundVehicle?.category).toBe('funds');
    expect(fundVehicle?.defaultEnabled).toBe(true);
    expect(fundVehicle?.navItem).toBe(false);
  });

  it('registers Ownership & Corporate Actions as an opt-in funds setting', () => {
    // Off by default so Startech (and any workspace that hasn't asked for it)
    // never sees the round dialog; an admin turns it on per workspace.
    const calc = FEATURE_CATALOG.find((feature) => feature.key === 'CORPORATE_ACTIONS_ENABLED');
    expect(calc).toBeDefined();
    expect(calc?.category).toBe('funds');
    expect(calc?.navItem).toBe(false);
    expect(calc?.defaultEnabled).toBe(false);

    const orig = process.env.CORPORATE_ACTIONS_ENABLED;
    try {
      delete process.env.CORPORATE_ACTIONS_ENABLED;
      expect(featureEnvDefault('CORPORATE_ACTIONS_ENABLED')).toBe(false);
    } finally {
      if (orig !== undefined) process.env.CORPORATE_ACTIONS_ENABLED = orig;
    }
  });

  it('defaults FUND_VEHICLE_VIEW_ENABLED to true and respects env overrides', () => {
    expect(featureEnvDefault('FUND_VEHICLE_VIEW_ENABLED')).toBe(true);

    const orig = process.env.FUND_VEHICLE_VIEW_ENABLED;
    try {
      process.env.FUND_VEHICLE_VIEW_ENABLED = 'false';
      expect(featureEnvDefault('FUND_VEHICLE_VIEW_ENABLED')).toBe(false);
      process.env.FUND_VEHICLE_VIEW_ENABLED = 'true';
      expect(featureEnvDefault('FUND_VEHICLE_VIEW_ENABLED')).toBe(true);
    } finally {
      if (orig === undefined) {
        delete process.env.FUND_VEHICLE_VIEW_ENABLED;
      } else {
        process.env.FUND_VEHICLE_VIEW_ENABLED = orig;
      }
    }
  });

  it('no longer exposes the pre-rename AI_FILE_DUMP_ENABLED key', () => {
    expect(FEATURE_CATALOG.some((feature) => feature.key === 'AI_FILE_DUMP_ENABLED')).toBe(false);
  });
});
