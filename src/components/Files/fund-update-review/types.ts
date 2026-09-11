import type {
  EntityField,
  EntityLink,
  EntityStatus,
  EntityTabKind,
  FundUpdateAssetReview,
  FundUpdateAssetStatus,
  FundUpdateCatalogKind,
  FundUpdateCatalogMatch,
  FundUpdateCatalogMatchStatus,
  FundUpdateTwoStepReview,
  MultiTransferAllocation,
  NonCashAdjustmentState,
  ReviewEntity,
  ReviewOption,
  ReviewReconciliation,
  ReviewTransaction,
  ReviewTransactionLeg,
  ReviewValuation,
  SingleTransferState,
  Step2TabKind,
  WizardStep,
} from "@/lib/fund_updates/types";

export type AssetStatus = FundUpdateAssetStatus;

export type {
  EntityField,
  EntityLink,
  EntityStatus,
  EntityTabKind,
  FundUpdateAssetReview,
  FundUpdateAssetStatus,
  FundUpdateCatalogKind,
  FundUpdateCatalogMatch,
  FundUpdateCatalogMatchStatus,
  FundUpdateTwoStepReview,
  MultiTransferAllocation,
  NonCashAdjustmentState,
  ReviewEntity,
  ReviewOption,
  ReviewReconciliation,
  ReviewTransaction,
  ReviewTransactionLeg,
  ReviewValuation,
  SingleTransferState,
  Step2TabKind,
  WizardStep,
};

export interface FundUpdateReviewData {
  kind: "fund_updates";
  file: {
    id: string;
    file_name: string;
    file_type: string | null;
    processing_status: string;
  };
  template_id: string | null;
  stats: Record<string, unknown> | null;
  summary: string | null;
  two_step_review: FundUpdateTwoStepReview;
}
