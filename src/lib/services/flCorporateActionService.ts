import type {
  DbClient,
  FlAssetRepository,
  FlCorporateActionRepository,
  FlFundRepository,
  FlInvestorRepository,
  FlLedgerEntryRepository,
  FlPositionRepository,
  FlValuationRepository,
  Tables,
} from '@/lib/repositories';
import {
  computeDirectOwnershipChange,
  computeFundingRound,
  findStaleFundingRounds,
  fundingRoundPositionValue,
  isOwnershipActionType,
  positionsMissingFollowOnEntry,
  readShareholdingPct,
  validateDirectOwnershipChange,
  validateFundingRound,
  type DirectOwnershipInput,
  type FundingRoundParticipantInput,
  type OwnershipActionType,
} from '@/lib/fundLedger/fundingRound';
import { distinctEnglishName } from '@/lib/fundLedger/format';
import { validateCurrency } from './flCurrency';
import { flAdd, toDecimalString } from './flDecimal';
import {
  EntityNotFoundError,
  CorporateActionValidationError,
  WorkspaceMismatchError,
} from './flErrors';

/** Only direct company holdings take corporate actions (not cash, loans, listed shares or fund stakes). */
const COMPANY_ASSET_KIND = 'equity';

/**
 * An equity asset that stands for a stake in another fund or partnership, the
 * same "Fund of Funds" label `FlLedgerService` uses to tell them apart.
 */
function isFundOfFundsAsset(asset: { instrument_terms?: unknown }): boolean {
  const terms = asset.instrument_terms as Record<string, unknown> | null | undefined;
  const label = terms?.investmentTypeLabel;
  return typeof label === 'string' && label.trim().toLowerCase() === 'fund of funds';
}

export interface OwnershipChangeRequest {
  position_id: string;
  /** Stake before, in percent points. Ignored for an opening stake. */
  pct_before?: string | null;
  /** Follow-on cash this position put into a funding round, raw currency units. */
  follow_on_amount?: string | null;
  pct_override?: string | null;
  override_remark?: string | null;
  /** Stake after, in percent points. Required for opening_stake / other; computed for a funding round. */
  pct_after?: string | null;
}

export interface CorporateActionWriteInput {
  action_date: string;
  label?: string | null;
  /** Funding round only. */
  currency?: string | null;
  /** Funding round only. Raw currency units (the dialog converts from millions). */
  pre_money?: string | null;
  round_size?: string | null;
  notes?: string | null;
  participants: OwnershipChangeRequest[];
}

export interface RecordCorporateActionInput extends CorporateActionWriteInput {
  asset_id: string;
  /** Defaults to funding_round. Fixed once recorded. */
  action_type?: OwnershipActionType;
  created_by?: string | null;
}

export interface OwnershipChangeView {
  id: string;
  position_id: string;
  holder_name: string | null;
  /** The holder's English name, when it has one that differs from `holder_name`. */
  holder_english_name: string | null;
  pct_before: string;
  follow_on_amount: string;
  pct_after: string;
  pct_override: string | null;
  override_remark: string | null;
  effective_pct: string;
  /** Funding round only: effective % × post-money, for reference. Never saved as a mark. */
  implied_value: string | null;
}

export interface CorporateActionView {
  id: string;
  asset_id: string;
  action_type: OwnershipActionType;
  action_date: string;
  label: string | null;
  currency: string | null;
  pre_money: string | null;
  round_size: string | null;
  post_money: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** An earlier action changed after this one was entered; its starting stakes are out of date. */
  stale: boolean;
  changes: OwnershipChangeView[];
}

export interface OwnershipPositionOption {
  position_id: string;
  holder_kind: 'fund' | 'investor' | null;
  holder_id: string | null;
  holder_name: string | null;
  /** The holder's English name, when it has one that differs from `holder_name`. */
  holder_english_name: string | null;
  /** Current stake (percent points); null when none is recorded. */
  current_pct: string | null;
  current_pct_as_of: string | null;
  /**
   * Where the current stake comes from: the latest ownership event, or — only
   * when the position has no ownership history yet — a quarterly mark's notes.
   */
  current_pct_source: 'ownership' | 'valuation' | null;
  /** The ownership event the current stake comes from, when there is one. */
  current_pct_event_id: string | null;
  opened_at: string | null;
}

export interface OwnershipContext {
  asset: { id: string; name: string; asset_kind: string };
  positions: OwnershipPositionOption[];
  /** Ownership history, oldest first. */
  actions: CorporateActionView[];
}

export interface CorporateActionWriteResult {
  action: CorporateActionView;
  /** Non-blocking reminders, e.g. a follow-on with no matching ledger entry. */
  warnings: string[];
}

/** One position's stake change, ready to persist, whatever the action type. */
interface ParticipationRow {
  positionId: string;
  preRoundPct: string;
  participationAmount: string;
  computedPct: string;
  overridePct: string | null;
  overrideRemark: string | null;
}

interface HolderName {
  name: string;
  /** Null when the holder has no English name, or it repeats `name`. */
  englishName: string | null;
}

interface PreparedChange {
  currency: string | null;
  preMoney: string | null;
  roundSize: string | null;
  rows: ParticipationRow[];
}

/**
 * Records corporate actions on a company — funding rounds, opening stakes and
 * other ownership changes — and the ownership % each of our positions in it has
 * before and after. The event lives on the asset; the effect is stored per
 * position. An action writes only its own rows: never a ledger entry and never
 * a valuation mark, so invested capital, realized proceeds, contributions and
 * market value stay exactly as they were.
 */
export class FlCorporateActionService {
  constructor(
    private readonly db: DbClient,
    private readonly actionRepo: FlCorporateActionRepository,
    private readonly valuationRepo: FlValuationRepository,
    private readonly positionRepo: FlPositionRepository,
    private readonly assetRepo: FlAssetRepository,
    private readonly fundRepo: FlFundRepository,
    private readonly investorRepo: FlInvestorRepository,
    private readonly ledgerEntryRepo: FlLedgerEntryRepository,
  ) {}

  private async withExecutor<T>(
    executor: DbClient | undefined,
    fn: (exec: DbClient) => Promise<T>,
  ): Promise<T> {
    if (executor) return fn(executor);
    return (this.db as any).transaction(async (tx: unknown) => fn(tx as DbClient));
  }

  /**
   * Everything the Ownership tab needs for one company: our positions in it
   * with their current stake, and its ownership history. A fixed handful of
   * batched queries.
   */
  async getContext(
    workspaceId: string,
    assetId: string,
    executor?: DbClient,
  ): Promise<OwnershipContext> {
    const asset = await this.assetRepo.findById(workspaceId, assetId, executor);
    if (!asset) {
      throw new EntityNotFoundError(`Asset ${assetId} not found in workspace ${workspaceId}`);
    }

    const [positions, rounds, assetMarks] = await Promise.all([
      this.positionRepo.findByAssetIds(workspaceId, [assetId], executor),
      this.actionRepo.findActionsByAssetIds(workspaceId, [assetId], executor),
      this.valuationRepo.findLatestByAssetIds(workspaceId, [assetId], null, executor),
    ]);
    const openPositions = positions.filter((p) => p.status !== 'closed');

    const [changes, positionMarks, holderNames] = await Promise.all([
      this.actionRepo.findChangesByActionIds(
        workspaceId,
        rounds.map((r) => r.id),
        executor,
      ),
      this.valuationRepo.findLatestByPositionIds(
        workspaceId,
        openPositions.map((p) => p.id),
        null,
        executor,
      ),
      this.loadHolderNames(workspaceId, positions, executor),
    ]);

    const history = this.toViews(rounds, changes, holderNames);

    // The ownership history is the source of truth: the last event a position
    // took part in sets its current stake. `history` is oldest first.
    const latestByPosition = new Map<string, { pct: string; asOf: string; eventId: string }>();
    for (const event of history) {
      for (const p of event.changes) {
        latestByPosition.set(p.position_id, {
          pct: p.effective_pct,
          asOf: event.action_date,
          eventId: event.id,
        });
      }
    }

    const markByPosition = new Map(positionMarks.map((v) => [v.position_id, v]));
    // An asset-level mark describes a single holder's stake only when there is one holder,
    // the same rule the holding view uses to show asset marks on a position.
    const soleAssetMark = openPositions.length === 1 ? assetMarks[0] : undefined;

    const positionOptions = openPositions.map((p): OwnershipPositionOption => {
      const base = {
        position_id: p.id,
        holder_kind: p.holder_fund_id ? ('fund' as const) : p.holder_investor_id ? ('investor' as const) : null,
        holder_id: p.holder_fund_id ?? p.holder_investor_id ?? null,
        holder_name: holderNames.get(p.id)?.name ?? null,
        holder_english_name: holderNames.get(p.id)?.englishName ?? null,
        opened_at: p.opened_at ?? null,
      };
      const latest = latestByPosition.get(p.id);
      if (latest) {
        return {
          ...base,
          current_pct: latest.pct,
          current_pct_as_of: latest.asOf,
          current_pct_source: 'ownership',
          current_pct_event_id: latest.eventId,
        };
      }
      const mark = markByPosition.get(p.id) ?? soleAssetMark;
      const pct = mark ? readShareholdingPct(mark.notes) : null;
      return {
        ...base,
        current_pct: pct,
        current_pct_as_of: pct != null && mark ? mark.as_of_date : null,
        current_pct_source: pct != null ? 'valuation' : null,
        current_pct_event_id: null,
      };
    });

    return {
      asset: { id: asset.id, name: asset.name, asset_kind: asset.asset_kind },
      positions: positionOptions,
      actions: history,
    };
  }

  async record(
    workspaceId: string,
    input: RecordCorporateActionInput,
    executor?: DbClient,
  ): Promise<CorporateActionWriteResult> {
    return this.withExecutor(executor, async (exec) => {
      const asset = await this.assetRepo.findById(workspaceId, input.asset_id, exec);
      if (!asset) {
        throw new WorkspaceMismatchError(
          `Asset ${input.asset_id} does not exist in workspace ${workspaceId}`,
        );
      }
      if (asset.asset_kind !== COMPANY_ASSET_KIND || isFundOfFundsAsset(asset)) {
        throw new CorporateActionValidationError(
          'Corporate actions apply to direct company holdings only, not cash, loans or fund-of-funds stakes.',
        );
      }

      const actionType = input.action_type ?? 'funding_round';
      if (!isOwnershipActionType(actionType)) {
        throw new CorporateActionValidationError(`Unknown corporate action type: ${String(actionType)}`);
      }
      const change = this.prepare(actionType, input);
      await this.checkPositions(workspaceId, input.asset_id, input.action_date, change.rows, exec);

      const round = await this.actionRepo.createAction(
        {
          workspace_id: workspaceId,
          asset_id: input.asset_id,
          action_type: actionType,
          action_date: input.action_date,
          label: input.label?.trim() || null,
          currency: change.currency,
          pre_money: change.preMoney,
          round_size: change.roundSize,
          notes: input.notes?.trim() || null,
          created_by: input.created_by ?? null,
          updated_by: input.created_by ?? null,
        },
        exec,
      );

      const written = await this.writeChanges(round.id, change.rows, exec);
      const warnings =
        actionType === 'funding_round'
          ? await this.followOnWarnings(workspaceId, round.action_date, change.rows, exec)
          : [];
      return { action: await this.loadView(workspaceId, round, written, exec), warnings };
    });
  }

  /**
   * Replaces an action's terms and participants; its type stays as recorded.
   * Later actions are not recomputed; they surface as `stale` instead.
   */
  async update(
    workspaceId: string,
    actionId: string,
    input: CorporateActionWriteInput,
    executor?: DbClient,
  ): Promise<CorporateActionWriteResult> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.actionRepo.findActionById(workspaceId, actionId, exec);
      if (!existing) {
        throw new EntityNotFoundError(`Corporate action ${actionId} not found in workspace ${workspaceId}`);
      }
      const actionType = this.actionTypeOf(existing);

      const change = this.prepare(actionType, input);
      await this.checkPositions(workspaceId, existing.asset_id, input.action_date, change.rows, exec);

      await this.actionRepo.deleteChangesByActionId(actionId, exec);
      const round = await this.actionRepo.updateAction(
        workspaceId,
        actionId,
        {
          action_date: input.action_date,
          label: input.label?.trim() || null,
          currency: change.currency,
          pre_money: change.preMoney,
          round_size: change.roundSize,
          notes: input.notes?.trim() || null,
        },
        exec,
      );
      if (!round) {
        throw new EntityNotFoundError(`Corporate action ${actionId} could not be updated`);
      }

      const written = await this.writeChanges(round.id, change.rows, exec);
      const warnings =
        actionType === 'funding_round'
          ? await this.followOnWarnings(workspaceId, round.action_date, change.rows, exec)
          : [];
      return { action: await this.loadView(workspaceId, round, written, exec), warnings };
    });
  }

  /** Deletes the action; its changes go with it. */
  async delete(workspaceId: string, actionId: string, executor?: DbClient): Promise<void> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.actionRepo.findActionById(workspaceId, actionId, exec);
      if (!existing) {
        throw new EntityNotFoundError(`Corporate action ${actionId} not found in workspace ${workspaceId}`);
      }
      await this.actionRepo.deleteAction(workspaceId, actionId, exec);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private actionTypeOf(round: Tables<'fl_corporate_actions'>): OwnershipActionType {
    return isOwnershipActionType(round.action_type) ? round.action_type : 'funding_round';
  }

  /** Validates the request for its action type and works out each position's stake after. */
  private prepare(actionType: OwnershipActionType, input: CorporateActionWriteInput): PreparedChange {
    if (typeof input.action_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.action_date)) {
      throw new CorporateActionValidationError('Date must be a YYYY-MM-DD date.');
    }
    if (!Array.isArray(input.participants)) {
      throw new CorporateActionValidationError('participants must be an array.');
    }
    const asString = (v: unknown, field: string): string => {
      if (typeof v !== 'string') {
        throw new CorporateActionValidationError(`${field} must be a decimal string.`);
      }
      return v;
    };

    if (actionType === 'funding_round') {
      const terms = {
        preMoney: asString(input.pre_money, 'pre_money'),
        roundSize: asString(input.round_size, 'round_size'),
      };
      const participants = input.participants.map((p): FundingRoundParticipantInput => ({
        positionId: asString(p.position_id, 'position_id'),
        preRoundPct: asString(p.pct_before, 'pct_before'),
        participationAmount:
          p.follow_on_amount == null || p.follow_on_amount === ''
            ? '0'
            : asString(p.follow_on_amount, 'follow_on_amount'),
        overridePct: p.pct_override == null ? null : asString(p.pct_override, 'pct_override'),
        overrideRemark: p.override_remark ?? null,
      }));
      const errors = validateFundingRound(terms, participants);
      if (errors.length > 0) {
        throw new CorporateActionValidationError(errors.join(' '));
      }
      const currency = validateCurrency(input.currency ?? '');
      const remarkById = new Map(participants.map((p) => [p.positionId, p.overrideRemark]));
      const result = computeFundingRound(terms, participants);
      return {
        currency,
        preMoney: terms.preMoney,
        roundSize: terms.roundSize,
        rows: result.participants.map((r) => ({
          positionId: r.positionId,
          preRoundPct: r.preRoundPct,
          participationAmount: r.participationAmount,
          computedPct: r.computedPct,
          overridePct: r.overridden ? r.effectivePct : null,
          overrideRemark: r.overridden ? remarkById.get(r.positionId)?.trim() ?? null : null,
        })),
      };
    }

    const participants = input.participants.map((p): DirectOwnershipInput => ({
      positionId: asString(p.position_id, 'position_id'),
      preRoundPct: actionType === 'opening_stake' ? '0' : asString(p.pct_before, 'pct_before'),
      pctAfter: asString(p.pct_after, 'pct_after'),
    }));
    const errors = validateDirectOwnershipChange(actionType, participants);
    if (errors.length > 0) {
      throw new CorporateActionValidationError(errors.join(' '));
    }
    return {
      currency: null,
      preMoney: null,
      roundSize: null,
      rows: computeDirectOwnershipChange(actionType, participants).map((r) => ({
        positionId: r.positionId,
        preRoundPct: r.preRoundPct,
        participationAmount: toDecimalString('0'),
        computedPct: r.pctAfter,
        overridePct: null,
        overrideRemark: null,
      })),
    };
  }

  /** Every named position must be an open holding of this company, opened by the action date. */
  private async checkPositions(
    workspaceId: string,
    assetId: string,
    actionDate: string,
    rows: ParticipationRow[],
    exec: DbClient,
  ): Promise<void> {
    const ids = rows.map((r) => r.positionId);
    const positions = await this.positionRepo.findByIds(workspaceId, ids, exec);
    const byId = new Map(positions.map((p) => [p.id, p]));
    for (const id of ids) {
      const pos = byId.get(id);
      if (!pos || pos.asset_id !== assetId) {
        throw new WorkspaceMismatchError(
          `Position ${id} does not hold this company in workspace ${workspaceId}`,
        );
      }
      if (pos.status === 'closed') {
        throw new CorporateActionValidationError('A closed position cannot take part in a corporate action.');
      }
      if (pos.opened_at && actionDate < pos.opened_at) {
        throw new CorporateActionValidationError(
          `The date (${actionDate}) is before a position was opened (${pos.opened_at}).`,
        );
      }
    }
  }

  private async writeChanges(
    actionId: string,
    rows: ParticipationRow[],
    exec: DbClient,
  ): Promise<Tables<'fl_ownership_changes'>[]> {
    return this.actionRepo.insertChanges(
      rows.map((r) => ({
        corporate_action_id: actionId,
        position_id: r.positionId,
        pct_before: r.preRoundPct,
        follow_on_amount: r.participationAmount,
        pct_after: r.computedPct,
        pct_override: r.overridePct,
        override_remark: r.overrideRemark,
      })),
      exec,
    );
  }

  private async followOnWarnings(
    workspaceId: string,
    roundDate: string,
    rows: ParticipationRow[],
    exec: DbClient,
  ): Promise<string[]> {
    const withFollowOn = rows.filter((r) => toDecimalString(r.participationAmount) !== '0.00000000');
    if (withFollowOn.length === 0) return [];
    const entries = await this.ledgerEntryRepo.findAllByPositionIds(
      workspaceId,
      withFollowOn.map((r) => r.positionId),
      exec,
    );
    const missing = positionsMissingFollowOnEntry(roundDate, withFollowOn, entries);
    if (missing.length === 0) return [];
    const names = await this.loadHolderNames(
      workspaceId,
      await this.positionRepo.findByIds(workspaceId, missing, exec),
      exec,
    );
    const label = (id: string) => {
      const n = names.get(id);
      if (!n) return 'A position';
      return n.englishName ? `${n.name} (${n.englishName})` : n.name;
    };
    return missing.map(
      (id) =>
        `${label(id)} put follow-on money into this round, but its ledger has no investment entry within 30 days of the round date. The round doesn't post cash; add the follow-on investment in Transactions.`,
    );
  }

  private async loadView(
    workspaceId: string,
    round: Tables<'fl_corporate_actions'>,
    changes: Tables<'fl_ownership_changes'>[],
    exec: DbClient,
  ): Promise<CorporateActionView> {
    const [siblings, positions] = await Promise.all([
      this.actionRepo.findActionsByAssetIds(workspaceId, [round.asset_id], exec),
      this.positionRepo.findByIds(
        workspaceId,
        changes.map((p) => p.position_id),
        exec,
      ),
    ]);
    const others = siblings.filter((r) => r.id !== round.id);
    const [otherParticipations, holderNames] = await Promise.all([
      this.actionRepo.findChangesByActionIds(
        workspaceId,
        others.map((r) => r.id),
        exec,
      ),
      this.loadHolderNames(workspaceId, positions, exec),
    ]);
    const views = this.toViews(
      [...others, round],
      [...otherParticipations, ...changes],
      holderNames,
    );
    return views.find((v) => v.id === round.id)!;
  }

  /** Views oldest first, with stale flags worked out across the whole history. */
  private toViews(
    rounds: Tables<'fl_corporate_actions'>[],
    changes: Tables<'fl_ownership_changes'>[],
    holderNames: Map<string, HolderName>,
  ): CorporateActionView[] {
    const byRound = new Map<string, Tables<'fl_ownership_changes'>[]>();
    for (const p of changes) {
      const list = byRound.get(p.corporate_action_id) ?? [];
      list.push(p);
      byRound.set(p.corporate_action_id, list);
    }

    const views = rounds.map((r): CorporateActionView => {
      const actionType = this.actionTypeOf(r);
      const priced = actionType === 'funding_round' && r.pre_money != null && r.round_size != null;
      const postMoney = priced ? flAdd(String(r.pre_money), String(r.round_size)) : null;
      return {
        id: r.id,
        asset_id: r.asset_id,
        action_type: actionType,
        action_date: r.action_date,
        label: r.label ?? null,
        currency: r.currency ?? null,
        pre_money: r.pre_money != null ? toDecimalString(String(r.pre_money)) : null,
        round_size: r.round_size != null ? toDecimalString(String(r.round_size)) : null,
        post_money: postMoney,
        notes: r.notes ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        stale: false,
        changes: (byRound.get(r.id) ?? []).map((p): OwnershipChangeView => {
          const effective = toDecimalString(String(p.pct_override ?? p.pct_after));
          return {
            id: p.id,
            position_id: p.position_id,
            holder_name: holderNames.get(p.position_id)?.name ?? null,
            holder_english_name: holderNames.get(p.position_id)?.englishName ?? null,
            pct_before: toDecimalString(String(p.pct_before)),
            follow_on_amount: toDecimalString(String(p.follow_on_amount)),
            pct_after: toDecimalString(String(p.pct_after)),
            pct_override: p.pct_override != null ? toDecimalString(String(p.pct_override)) : null,
            override_remark: p.override_remark ?? null,
            effective_pct: effective,
            implied_value: postMoney != null ? fundingRoundPositionValue(effective, postMoney) : null,
          };
        }),
      };
    });

    const stale = findStaleFundingRounds(
      views.map((v) => ({
        id: v.id,
        roundDate: v.action_date,
        createdAt: v.created_at,
        resetsChain: v.action_type === 'opening_stake',
        changes: v.changes.map((p) => ({
          positionId: p.position_id,
          preRoundPct: p.pct_before,
          effectivePct: p.effective_pct,
        })),
      })),
    );
    return views
      .map((v) => ({ ...v, stale: stale.has(v.id) }))
      .sort(
        (a, b) =>
          a.action_date.localeCompare(b.action_date) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      );
  }

  /** Holder display names per position id, in two batched lookups. */
  private async loadHolderNames(
    workspaceId: string,
    positions: Tables<'fl_positions'>[],
    exec?: DbClient,
  ): Promise<Map<string, HolderName>> {
    const fundIds = Array.from(
      new Set(positions.map((p) => p.holder_fund_id).filter((id): id is string => id != null)),
    );
    const investorIds = Array.from(
      new Set(positions.map((p) => p.holder_investor_id).filter((id): id is string => id != null)),
    );
    const [funds, investors] = await Promise.all([
      fundIds.length > 0 ? this.fundRepo.findByIds(workspaceId, fundIds, exec) : Promise.resolve([]),
      investorIds.length > 0
        ? this.investorRepo.findByIds(workspaceId, investorIds, exec)
        : Promise.resolve([]),
    ]);
    const toName = (row: { name: string; english_name?: string | null }): HolderName => ({
      name: row.name,
      englishName: distinctEnglishName(row.name, row.english_name) ?? null,
    });
    const fundName = new Map(funds.map((f) => [f.id, toName(f)]));
    const investorName = new Map(investors.map((i) => [i.id, toName(i)]));
    const names = new Map<string, HolderName>();
    for (const p of positions) {
      const name =
        (p.holder_fund_id ? fundName.get(p.holder_fund_id) : undefined) ??
        (p.holder_investor_id ? investorName.get(p.holder_investor_id) : undefined);
      if (name) names.set(p.id, name);
    }
    return names;
  }
}
