import type {
  ParsedAsset,
  ProposedEntity,
  ProposedEntityType,
  ProposedEvent,
} from './types';

export type FundUpdateCatalogKind = 'asset' | 'fund' | 'investor' | 'source';

export interface LinkableAsset {
  code: string;
  name?: string | null;
  fund?: string | null;
  entity?: string | null;
  funding_source?: string | null;
  fundingSource?: string | null;
  fundingSourceRaw?: string | null;
  legalName?: string | null;
  assetType?: string | null;
}

export interface AssetCodesForCatalogNameParams {
  catalogName: string;
  kind: FundUpdateCatalogKind;
  assets: Array<LinkableAsset | ParsedAsset>;
  entities?: ProposedEntity[] | null;
  events?: ProposedEvent[] | null;
}

const INVESTOR_ENTITY_TYPES: ReadonlySet<ProposedEntityType> = new Set<ProposedEntityType>([
  'investor',
  'institutional_investor',
  'individual_investor',
  'investment_vehicle',
]);

function normalizeString(val: string | null | undefined): string {
  if (typeof val !== 'string') return '';
  return val.trim().toLowerCase();
}

function findEntityByRef(
  ref: string | null | undefined,
  entities: ProposedEntity[],
): ProposedEntity | undefined {
  const norm = normalizeString(ref);
  if (!norm) return undefined;
  return entities.find((e) => {
    if (normalizeString(e.proposalId) === norm) return true;
    if (normalizeString(e.originalName) === norm) return true;
    if (normalizeString(e.englishName) === norm) return true;
    if (Array.isArray(e.aliases) && e.aliases.some((alias) => normalizeString(alias) === norm)) {
      return true;
    }
    return false;
  });
}

function refMatchesAsset(
  ref: string | null | undefined,
  asset: LinkableAsset | ParsedAsset,
  entities: ProposedEntity[],
): boolean {
  const norm = normalizeString(ref);
  if (!norm) return false;
  if (norm === normalizeString(asset.code)) return true;
  if (asset.name && norm === normalizeString(asset.name)) return true;
  if (asset.legalName && norm === normalizeString(asset.legalName)) return true;

  const ent = findEntityByRef(ref, entities);
  if (ent) {
    if (normalizeString(ent.proposalId) === normalizeString(asset.code)) return true;
    if (asset.name && normalizeString(ent.originalName) === normalizeString(asset.name)) return true;
    if (asset.legalName && normalizeString(ent.englishName) === normalizeString(asset.legalName)) {
      return true;
    }
  }
  return false;
}

function eventMentionsAsset(
  ev: ProposedEvent,
  asset: LinkableAsset | ParsedAsset,
  entities: ProposedEntity[],
): boolean {
  const refs = [ev.toEntityRef, ev.fromEntityRef, ev.counterpartyRef, ev.relatedFundRef];
  return refs.some((ref) => refMatchesAsset(ref, asset, entities));
}

/**
 * Hydrates empty `entity` or `fund` fields on ParsedAssets from workbook fallback events.
 * Returns a new array of cloned assets without mutating input.
 */
export function hydrateParsedAssetsFromEvents(
  assets: ParsedAsset[],
  entities?: ProposedEntity[] | null,
  events?: ProposedEvent[] | null,
): ParsedAsset[] {
  if (!Array.isArray(assets) || assets.length === 0) {
    return [];
  }

  const safeEntities = Array.isArray(entities) ? entities : [];
  const safeEvents = Array.isArray(events) ? events : [];

  const clonedAssets: ParsedAsset[] = assets.map((asset) => ({
    ...asset,
    valuations: Array.isArray(asset.valuations) ? [...asset.valuations] : [],
    txns: Array.isArray(asset.txns) ? [...asset.txns] : [],
  }));

  if (safeEvents.length === 0) {
    return clonedAssets;
  }

  for (const asset of clonedAssets) {
    const hasEntity = typeof asset.entity === 'string' && asset.entity.trim().length > 0;
    const hasFund = typeof asset.fund === 'string' && asset.fund.trim().length > 0;

    if (hasEntity && hasFund) {
      continue;
    }

    for (const ev of safeEvents) {
      if (!eventMentionsAsset(ev, asset, safeEntities)) {
        continue;
      }

      // If entity is empty: first event mentioning the asset and an investor-type entity -> set entity
      const currentEntity = asset.entity;
      const entityEmpty = typeof currentEntity !== 'string' || currentEntity.trim().length === 0;
      if (entityEmpty) {
        const candidateRefs = [ev.fromEntityRef, ev.toEntityRef, ev.counterpartyRef, ev.relatedFundRef].filter(
          (ref) => typeof ref === 'string' && ref.trim().length > 0 && !refMatchesAsset(ref, asset, safeEntities),
        );
        for (const ref of candidateRefs) {
          const ent = findEntityByRef(ref, safeEntities);
          if (ent && INVESTOR_ENTITY_TYPES.has(ent.entityType)) {
            asset.entity = ent.originalName;
            break;
          }
        }
      }

      // If fund is empty: relatedFundRef on such an event, or an entityType === 'fund' ref
      const currentFund = asset.fund;
      const fundEmpty = typeof currentFund !== 'string' || currentFund.trim().length === 0;
      if (fundEmpty) {
        if (typeof ev.relatedFundRef === 'string' && ev.relatedFundRef.trim().length > 0) {
          asset.fund = ev.relatedFundRef.trim();
        } else {
          const candidateRefs = [ev.fromEntityRef, ev.toEntityRef, ev.counterpartyRef].filter(
            (ref) => typeof ref === 'string' && ref.trim().length > 0 && !refMatchesAsset(ref, asset, safeEntities),
          );
          for (const ref of candidateRefs) {
            const ent = findEntityByRef(ref, safeEntities);
            if (ent && ent.entityType === 'fund') {
              asset.fund = ent.originalName;
              break;
            }
          }
        }
      }

      const updatedEntity = asset.entity;
      const updatedFund = asset.fund;
      const isEntitySet = typeof updatedEntity === 'string' && updatedEntity.trim().length > 0;
      const isFundSet = typeof updatedFund === 'string' && updatedFund.trim().length > 0;

      if (isEntitySet && isFundSet) {
        break;
      }
    }
  }

  return clonedAssets;
}

/**
 * Computes deduped projected asset codes relating to a catalog item (fund, investor, source, asset).
 */
export function assetCodesForCatalogName(params: AssetCodesForCatalogNameParams): string[] {
  const { catalogName, kind, assets, entities, events } = params;

  if (typeof catalogName !== 'string' || catalogName.trim().length === 0) {
    return [];
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    return [];
  }

  const catalogNameNorm = normalizeString(catalogName);
  const safeEntities = Array.isArray(entities) ? entities : [];
  const safeEvents = Array.isArray(events) ? events : [];

  const matchingEntities = safeEntities.filter((e) => {
    if (normalizeString(e.proposalId) === catalogNameNorm) return true;
    if (normalizeString(e.originalName) === catalogNameNorm) return true;
    if (normalizeString(e.englishName) === catalogNameNorm) return true;
    if (Array.isArray(e.aliases) && e.aliases.some((alias) => normalizeString(alias) === catalogNameNorm)) {
      return true;
    }
    return false;
  });

  function refMentionsCatalog(ref: string | null | undefined): boolean {
    const norm = normalizeString(ref);
    if (!norm) return false;
    if (norm === catalogNameNorm) return true;
    for (const e of matchingEntities) {
      if (normalizeString(e.proposalId) === norm) return true;
      if (normalizeString(e.originalName) === norm) return true;
      if (normalizeString(e.englishName) === norm) return true;
      if (Array.isArray(e.aliases) && e.aliases.some((alias) => normalizeString(alias) === norm)) {
        return true;
      }
    }
    return false;
  }

  const resultCodes: string[] = [];
  const addedSet = new Set<string>();

  function addCode(code: string | null | undefined): void {
    if (typeof code !== 'string' || code.trim().length === 0) return;
    const trimmed = code.trim();
    if (!addedSet.has(trimmed)) {
      addedSet.add(trimmed);
      resultCodes.push(trimmed);
    }
  }

  // 1. Direct field matching
  for (const asset of assets) {
    if (kind === 'investor') {
      const assetEntityNorm = normalizeString(asset.entity);
      if (assetEntityNorm && assetEntityNorm === catalogNameNorm) {
        addCode(asset.code);
      } else if (
        assetEntityNorm &&
        matchingEntities.some((e) => {
          if (normalizeString(e.originalName) === assetEntityNorm) return true;
          if (normalizeString(e.proposalId) === assetEntityNorm) return true;
          if (normalizeString(e.englishName) === assetEntityNorm) return true;
          return false;
        })
      ) {
        addCode(asset.code);
      }
    } else if (kind === 'fund') {
      const assetFundNorm = normalizeString(asset.fund);
      if (assetFundNorm && assetFundNorm === catalogNameNorm) {
        addCode(asset.code);
      } else if (
        assetFundNorm &&
        matchingEntities.some((e) => {
          if (normalizeString(e.originalName) === assetFundNorm) return true;
          if (normalizeString(e.proposalId) === assetFundNorm) return true;
          if (normalizeString(e.englishName) === assetFundNorm) return true;
          return false;
        })
      ) {
        addCode(asset.code);
      } else if (
        matchingEntities.some((e) => e.entityType === 'fund_or_partnership_asset') ||
        asset.assetType === 'fund_of_funds'
      ) {
        if (normalizeString(asset.code) === catalogNameNorm || (asset.name && normalizeString(asset.name) === catalogNameNorm)) {
          addCode(asset.code);
        }
      }
    } else if (kind === 'source') {
      const sourceNorm = 'fundingSource' in asset ? normalizeString(asset.fundingSource) : '';
      const sourceRawNorm = 'fundingSourceRaw' in asset ? normalizeString(asset.fundingSourceRaw) : '';
      const sourceUnderNorm = 'funding_source' in asset ? normalizeString(asset.funding_source) : '';
      if (sourceNorm === catalogNameNorm || sourceRawNorm === catalogNameNorm || sourceUnderNorm === catalogNameNorm) {
        addCode(asset.code);
      }
    } else if (kind === 'asset') {
      if (normalizeString(asset.code) === catalogNameNorm || (asset.name && normalizeString(asset.name) === catalogNameNorm)) {
        addCode(asset.code);
      }
    }
  }

  // 2. Direct event matching
  if (safeEvents.length > 0) {
    for (const ev of safeEvents) {
      const eventRefs = [ev.fromEntityRef, ev.toEntityRef, ev.relatedFundRef, ev.counterpartyRef];
      const mentionsCatalog = eventRefs.some(refMentionsCatalog);
      if (!mentionsCatalog) {
        continue;
      }

      for (const asset of assets) {
        if (eventMentionsAsset(ev, asset, safeEntities)) {
          addCode(asset.code);
        }
      }
    }
  }

  // 3. Investor via fund matching
  const isInvestorCatalog =
    kind === 'investor' ||
    matchingEntities.some((e) => INVESTOR_ENTITY_TYPES.has(e.entityType));

  if (isInvestorCatalog && safeEvents.length > 0) {
    const matchedFundNames = new Set<string>();

    for (const ev of safeEvents) {
      const eventRefs = [ev.fromEntityRef, ev.toEntityRef, ev.counterpartyRef, ev.relatedFundRef];
      const mentionsInvestor = eventRefs.some(refMentionsCatalog);
      if (!mentionsInvestor) {
        continue;
      }

      if (typeof ev.relatedFundRef === 'string' && ev.relatedFundRef.trim().length > 0) {
        matchedFundNames.add(normalizeString(ev.relatedFundRef));
      }

      const entityRefs = [ev.fromEntityRef, ev.toEntityRef, ev.counterpartyRef];
      for (const ref of entityRefs) {
        const ent = findEntityByRef(ref, safeEntities);
        if (ent && ent.entityType === 'fund') {
          matchedFundNames.add(normalizeString(ent.originalName));
          if (ent.englishName) {
            matchedFundNames.add(normalizeString(ent.englishName));
          }
          if (ent.proposalId) {
            matchedFundNames.add(normalizeString(ent.proposalId));
          }
        }
      }
    }

    if (matchedFundNames.size > 0) {
      for (const asset of assets) {
        const assetFundNorm = normalizeString(asset.fund);
        if (assetFundNorm && matchedFundNames.has(assetFundNorm)) {
          addCode(asset.code);
        }
      }
    }
  }

  return resultCodes;
}
