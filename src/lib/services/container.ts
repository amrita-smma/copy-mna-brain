import { createDb } from '@/lib/server/db';
import type { DbClient } from '@/lib/repositories';
import {
  CompanyRepository,
  CompanyLogRepository,
  ScreeningRepository,
  CriteriaRepository,
  DealDocumentRepository,
  DealNoteRepository,
  DealLinkRepository,
  CompanyAnalysisRepository,
  CompanyFinancialRepository,
  CompanyFxAdjustmentRepository,
  CompanyScreeningDerivedRepository,
  CompanySlidesRepository,
  CompanyVoteRepository,
  FileRepository,
  InvestmentThesisRepository,
  TrackVariableRepository,
  PipelineStageRepository,
  JobRepository,
  ResetPasswordTokenRepository,
  UserRepository,
  RecentFileRepository,
  UserTaskRepository,
  EmployerRepository,
  EmployerCurationRepository,
  EmployerRelatedCompanyRepository,
  EmployerDomainRepository,
  CorrespondentRepository,
  CorrespondentCurationRepository,
  EmployerNoteRepository,
  TopicRepository,
  EmailRepository,
  EmployerTeamRepository,
  AiWorkforceQueueRepository,
  CopilotChatsRepository,
  AlphasenseToolCallRepository,
  DashboardActivityRepository,
  DashboardInsightsRepository,
  AppSettingsRepository,
  DailyPulseRepository,
  FeatureFlagRepository,
  ApiKeyRepository,
  ApiChatConversationRepository,
  RoutinesRepository,
  UserWorkspaceRepository,
  WorkspaceRepository,
  RoleRepository,
  WorkspaceCorrespondentRepository,
  WorkspaceTableLayoutRepository,
  FeedbackRepository,
  RssFeedRepository,
  RssItemRepository,
  RssItemChunkRepository,
  UserConsentRepository,
  FlInvestorRepository,
  FlFundRepository,
  FlAssetRepository,
  FlFundingSourceRepository,
  FlInvestmentTypeRepository,
  FlPositionRepository,
  FlBusinessEventRepository,
  FlBusinessEventRevisionRepository,
  FlLedgerEntryRepository,
  FlAllocationRepository,
  FlValuationRepository,
  FlCorporateActionRepository,
  FlSourceRecordRepository,
  InsightRepository,
  InsightVersionRepository,
  InsightRunDraftRepository,
  InsightTemplateRepository,
  AgentCheckpointRepository,
  UserMemoryRepository,
} from '@/lib/repositories';
import { JobDispatcher } from './jobDispatcher';
import { CompanyService } from './companyService';
import { CompanyGraphService } from './companyGraphService';
import { CompanyRelationshipService } from './companyRelationshipService';
import { FlMasterDataService } from './flMasterDataService';
import { FlInvestmentTypeService } from './flInvestmentTypeService';
import { FlPositionService } from './flPositionService';
import { FlLedgerService } from './flLedgerService';
import { FlValuationService } from './flValuationService';
import { FlCorporateActionService } from './flCorporateActionService';
import { FlBalanceService } from './flBalanceService';
import { FlPortfolioService } from './flPortfolioService';
import { createNeo4jDriver } from '@/lib/neo4j';
import { CompanyRelationRepository } from '@/lib/repositories/companyRelationRepository';
import { ScreeningService } from './screeningService';
import { ClientHealthService } from './clientHealthService';
import { CriteriaService } from './criteriaService';
import { InvestmentThesisService } from './investmentThesisService';
import { TrackVariableService } from './trackVariableService';
import { PipelineStageService } from './pipelineStageService';
import { MarketScanningRoutineService } from './marketScanningRoutineService';
import { DealDocumentService } from './dealDocumentService';
import { RecentFileService } from './recentFileService';
import { UserTaskService } from './userTaskService';
import { DealNoteService } from './dealNoteService';
import { DealLinkService } from './dealLinkService';
import { CompanyAnalysisService } from './companyAnalysisService';
import { AiOpinionService } from './aiOpinionService';
import { FundAiOpinionService } from './fundAiOpinionService';
import { AIScreeningService } from './aiScreeningService';
import { MarketScreeningService } from './marketScreeningService';
import { TrackMatchingService } from './trackMatchingService';
import { PendingAutoScanService } from './pendingAutoScanService';
import { SlideService } from './slideService';
import { CompanyCardSlideService } from './companyCardSlideService';
import { CompanyVoteService } from './companyVoteService';
import { FileService } from './fileService';
import { ChatService } from './chatService';
import { JobService } from './jobService';
import { AuthService } from './authService';
import { UserService } from './userService';
import { CRMService } from './crmService';
import { CrmContactEnrichmentService } from './crmContactEnrichmentService';
import { CompanyContactDiscoveryService } from './companyContactDiscoveryService';
import { AiWorkforceService } from './aiWorkforceService';
import { CopilotChatsService } from './copilotChatsService';
import { AlphasenseToolCallService } from './alphasenseToolCallService';
import { DashboardActivityService } from './dashboardActivityService';
import { DashboardInsightsService } from './dashboardInsightsService';
import { DailyPulseService } from './dailyPulseService';
import { ApiKeyService } from './apiKeyService';
import { ApiChatConversationService } from './apiChatConversationService';
import { NotificationService } from './notificationService';
import { WorkspaceService } from './workspaceService';
import { DealResurfaceService } from './dealResurfaceService';
import { ChatAttachmentService } from './chatAttachmentService';
import { FundUpdateApplyService } from './fundUpdateApplyService';
import { FundCatalogCheckService } from './fundCatalogCheckService';
import { StalledDealService } from './stalledDealService';
import { FeatureFlagsService } from './featureFlagsService';
import { TableLayoutService } from './tableLayoutService';
import { FeedbackService } from './feedbackService';
import { RssFeedService } from './rssFeedService';
import { DataNavigatorService } from './dataNavigatorService';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
import { ConsentService } from './consentService';
import { InsightService } from './insightService';
import { ProfileService } from './profileService';
import { UserMemoryService } from './userMemoryService';
import { UserProfileService } from './userProfileService';
import { InterventionRecipientService } from './interventionRecipientService';
import { InsightTemplateService } from './insightTemplateService';
import { RoutineService } from './routineService';
import { enqueueAgentRun } from '@/lib/workforce/enqueue';

export interface Container {
  companyService: CompanyService;
  companyGraphService: CompanyGraphService;
  companyRelationshipService: CompanyRelationshipService;
  screeningService: ScreeningService;
  clientHealthService: ClientHealthService;
  criteriaService: CriteriaService;
  investmentThesisService: InvestmentThesisService;
  trackVariableService: TrackVariableService;
  pipelineStageService: PipelineStageService;
  marketScanningRoutineService: MarketScanningRoutineService;
  dealDocumentService: DealDocumentService;
  recentFileService: RecentFileService;
  userTaskService: UserTaskService;
  dealNoteService: DealNoteService;
  dealLinkService: DealLinkService;
  companyAnalysisService: CompanyAnalysisService;
  aiOpinionService: AiOpinionService;
  aiScreeningService: AIScreeningService;
  marketScreeningService: MarketScreeningService;
  trackMatchingService: TrackMatchingService;
  pendingAutoScanService: PendingAutoScanService;
  slideService: SlideService;
  companyCardSlideService: CompanyCardSlideService;
  companyVoteService: CompanyVoteService;
  fileService: FileService;
  chatService: ChatService;
  jobService: JobService;
  authService: AuthService;
  userService: UserService;
  crmService: CRMService;
  crmContactEnrichmentService: CrmContactEnrichmentService;
  companyContactDiscoveryService: CompanyContactDiscoveryService;
  aiWorkforceService: AiWorkforceService;
  copilotChatsService: CopilotChatsService;
  alphasenseToolCallService: AlphasenseToolCallService;
  dashboardActivityService: DashboardActivityService;
  dashboardInsightsService: DashboardInsightsService;
  dailyPulseService: DailyPulseService;
  apiKeyService: ApiKeyService;
  apiChatConversationService: ApiChatConversationService;
  notificationService: NotificationService;
  workspaceService: WorkspaceService;
  dealResurfaceService: DealResurfaceService;
  chatAttachmentService: ChatAttachmentService;
  fundUpdateApplyService: FundUpdateApplyService;
  fundCatalogCheckService: FundCatalogCheckService;
  fundAiOpinionService: FundAiOpinionService;
  stalledDealService: StalledDealService;
  featureFlagsService: FeatureFlagsService;
  feedbackService: FeedbackService;
  tableLayoutService: TableLayoutService;
  rssFeedService: RssFeedService;
  dataNavigatorService: DataNavigatorService;
  consentService: ConsentService;
  flMasterDataService: FlMasterDataService;
  flInvestmentTypeService: FlInvestmentTypeService;
  flPositionService: FlPositionService;
  flLedgerService: FlLedgerService;
  flValuationService: FlValuationService;
  flCorporateActionService: FlCorporateActionService;
  flBalanceService: FlBalanceService;
  flPortfolioService: FlPortfolioService;
  insightService: InsightService;
  profileService: ProfileService;
  /**
   * The CoPilot's long-term memory. A factory, not an instance: every memory
   * is scoped to one user as well as to the workspace, and the container is
   * built before a route knows who is signed in. Call it with the session
   * user's id and nothing else can reach their memories.
   */
  userMemoryService: (userId: string) => UserMemoryService;
  userProfileService: UserProfileService;
  interventionRecipientService: InterventionRecipientService;
  insightTemplateService: InsightTemplateService;
  routineService: RoutineService;
}

/** Build on first call, then hand back the same instance forever. */
function lazy<T>(build: () => T): () => T {
  let built = false;
  let value: T;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value;
  };
}

/**
 * Every repository and service below is wrapped in `lazy(...)`, and the
 * returned object exposes them through memoized getters. A route handler that
 * destructures one service (`const { jobService } = createContainer(db, ws)`)
 * therefore constructs that service's dependency chain and nothing else —
 * previously every one of the ~74 repositories and 62 services was newed up
 * on every request regardless of which single one the handler used (see
 * TECH_DEBT.md "createContainer eagerly constructs every service").
 *
 * Inside a factory, a dependency is another `lazy` thunk, so it is always
 * *called* (`companyRepo()`), never passed bare. Construction order follows
 * first access instead of source order; the thunks close over `const`
 * bindings, so a factory may freely reference one declared later in the file.
 */
export function createContainer(db: DbClient, workspaceId: string): Container {
  const jobDispatcher = lazy(() => new JobDispatcher(db, createDb, workspaceId));

  // Neo4j mirror: the relationship-graph repo doubles as the write-through
  // mirror for company writes. The driver is a cached global singleton, and
  // with the lazy container it is only created once a request actually touches
  // a company or the graph. Postgres stays the source of truth — Neo4j
  // follows every insert/update/delete that flows through CompanyRepository.
  const companyGraphRepo = lazy(() => new CompanyRelationRepository(createNeo4jDriver()));

  const companyRepo = lazy(() => new CompanyRepository(db, workspaceId, companyGraphRepo()));
  const companyLogRepo = lazy(() => new CompanyLogRepository(db, workspaceId));
  const screeningRepo = lazy(() => new ScreeningRepository(db, workspaceId));
  const criteriaRepo = lazy(() => new CriteriaRepository(db, workspaceId));
  const dealDocRepo = lazy(() => new DealDocumentRepository(db, workspaceId));
  const dealNoteRepo = lazy(() => new DealNoteRepository(db, workspaceId));
  const dealLinkRepo = lazy(() => new DealLinkRepository(db, workspaceId));
  const companyAnalysisRepo = lazy(() => new CompanyAnalysisRepository(db, workspaceId));
  const companySlidesRepo = lazy(() => new CompanySlidesRepository(db, workspaceId));
  const fileRepo = lazy(() => new FileRepository(db, workspaceId));
  const thesisRepo = lazy(() => new InvestmentThesisRepository(db, workspaceId));
  const trackVariableRepo = lazy(() => new TrackVariableRepository(db, workspaceId));
  const pipelineStageRepo = lazy(() => new PipelineStageRepository(db, workspaceId));
  const jobRepo = lazy(() => new JobRepository(db));
  const userRepo = lazy(() => new UserRepository(db));
  const resetTokenRepo = lazy(() => new ResetPasswordTokenRepository(db));
  const recentFileRepo = lazy(() => new RecentFileRepository(db, workspaceId));
  const companyFinancialRepo = lazy(() => new CompanyFinancialRepository(db, workspaceId));
  const companyFxAdjustmentRepo = lazy(() => new CompanyFxAdjustmentRepository(db, workspaceId));
  const companyScreeningDerivedRepo = lazy(
    () => new CompanyScreeningDerivedRepository(db, workspaceId),
  );
  const userWorkspaceRepo = lazy(() => new UserWorkspaceRepository(db));
  const workspaceRepo = lazy(() => new WorkspaceRepository(db));
  const roleRepo = lazy(() => new RoleRepository(db));

  const criteriaService = lazy(() => new CriteriaService(criteriaRepo()));
  const screeningService = lazy(() => new ScreeningService(screeningRepo(), workspaceId));
  const clientHealthService = lazy(() => new ClientHealthService(workspaceId));
  const routinesRepo = lazy(() => new RoutinesRepository(db, workspaceId));
  const marketScanningRoutineService = lazy(
    () => new MarketScanningRoutineService(routinesRepo()),
  );
  const investmentThesisService = lazy(
    () => new InvestmentThesisService(thesisRepo(), marketScanningRoutineService()),
  );
  const trackVariableService = lazy(() => new TrackVariableService(trackVariableRepo()));
  const dealNoteService = lazy(() => new DealNoteService(dealNoteRepo()));
  const dealLinkService = lazy(() => new DealLinkService(dealLinkRepo(), dealDocRepo()));
  const jobService = lazy(() => new JobService(jobRepo(), db));
  const authService = lazy(() => new AuthService(userRepo(), resetTokenRepo()));
  const userService = lazy(() => new UserService(userRepo(), workspaceId, authService()));
  const chatService = lazy(() => new ChatService(thesisRepo(), criteriaRepo()));
  const workspaceService = lazy(
    () => new WorkspaceService(workspaceRepo(), userWorkspaceRepo(), roleRepo(), userRepo()),
  );

  const companyAnalysisService = lazy(
    () => new CompanyAnalysisService(companyAnalysisRepo(), companyRepo(), db, workspaceId),
  );
  const aiOpinionService = lazy(
    () => new AiOpinionService(companyRepo(), db, workspaceId, aiScreeningService()),
  );
  const aiScreeningService = lazy(
    () =>
      new AIScreeningService(
        db,
        workspaceId,
        companyRepo(),
        screeningRepo(),
        criteriaRepo(),
        thesisRepo(),
        screeningService(),
        aiWorkforceQueueRepo(),
      ),
  );
  const marketScreeningService = lazy(() => new MarketScreeningService(jobDispatcher()));
  const trackMatchingService = lazy(
    () => new TrackMatchingService(jobDispatcher(), db, workspaceId),
  );
  const slideService = lazy(() => new SlideService(companySlidesRepo(), jobDispatcher()));

  const companyService = lazy(() => {
    const service = new CompanyService(
      workspaceId,
      companyRepo(),
      companyLogRepo(),
      dealDocRepo(),
      dealNoteRepo(),
      dealLinkRepo(),
      companyFinancialRepo(),
      companyFxAdjustmentRepo(),
      companyScreeningDerivedRepo(),
      trackMatchingService(),
      userRepo(),
      fileRepo(),
      // A pipeline stage move regenerates the AI Company Card against the latest
      // information (see CompanyService.promote / promoteMany / updateFromDTO).
      companyAnalysisService(),
      pipelineStageRepo(),
    );
    // A company entering Pending triggers the auto-scan. The handler is unset-
    // tolerant (notifyPendingArrival no-ops without it), so it must be wired on
    // every CompanyService — and the scan service is resolved only when the
    // handler fires, because its constructor takes companyService back.
    // Pipeline Settings → Required Fields gates pipeline entry per workspace.
    service.setWorkspaceRepo(workspaceRepo());
    service.setPendingArrivalHandler((companyIds, triggeredByUserId) =>
      pendingAutoScanService().onCompaniesEnteredPending(companyIds, triggeredByUserId),
    );
    return service;
  });
  const pipelineStageService = lazy(
    () => new PipelineStageService(pipelineStageRepo(), companyRepo(), companyService()),
  );
  const companyCardSlideService = lazy(
    () =>
      new CompanyCardSlideService(
        companyService(),
        companyAnalysisService(),
        investmentThesisService(),
        trackVariableService(),
        workspaceService(),
        workspaceId,
        pipelineStageRepo(),
      ),
  );
  const companyVoteRepo = lazy(() => new CompanyVoteRepository(db, workspaceId));
  const companyVoteService = lazy(
    () =>
      new CompanyVoteService(
        companyVoteRepo(),
        userRepo(),
        companyRepo(),
        workspaceRepo(),
        companyCardSlideService(),
        aiOpinionService(),
        jobDispatcher(),
        workspaceId,
      ),
  );
  const companyGraphService = lazy(
    () => new CompanyGraphService(companyGraphRepo(), jobDispatcher()),
  );
  const companyRelationshipService = lazy(
    () =>
      new CompanyRelationshipService(companyRepo(), companyService(), companyGraphService()),
  );
  const dealDocumentService = lazy(
    () => new DealDocumentService(dealDocRepo(), dealLinkRepo(), jobDispatcher(), workspaceId),
  );
  const recentFileService = lazy(() => new RecentFileService(recentFileRepo()));
  const userTaskService = lazy(
    () =>
      new UserTaskService(
        new UserTaskRepository(db, workspaceId),
        userRepo(),
        workspaceRepo(),
        workspaceId,
      ),
  );
  const pendingAutoScanService = lazy(
    () =>
      new PendingAutoScanService(
        workspaceId,
        companyRepo(),
        screeningRepo(),
        workspaceService(),
        companyService(),
        aiScreeningService(),
        trackMatchingService(),
        companyAnalysisService(),
        companyRelationshipService(),
      ),
  );
  const fileService = lazy(() => {
    const service = new FileService(
      db,
      workspaceId,
      fileRepo(),
      companyAnalysisService(),
      aiScreeningService(),
      criteriaRepo(),
      screeningRepo(),
      companyFinancialRepo(),
      companyService(),
      companyFxAdjustmentRepo(),
      userWorkspaceRepo(),
      trackMatchingService(),
      userRepo(),
    );
    // Setter-injected collaborators (they would otherwise be constructor
    // cycles). Applied inside the factory so a fully-wired FileService is
    // still the only FileService anyone can observe.
    service.setWorkspaceRepo(workspaceRepo());
    service.setCRMService(crmService());
    service.setJobDispatcher(jobDispatcher());
    service.setFundUpdateApplyService(fundUpdateApplyService());
    service.setFundCatalogCheckService(fundCatalogCheckService());
    service.setPendingAutoScanService(pendingAutoScanService());
    return service;
  });

  const employerRepo = lazy(() => new EmployerRepository(db));
  const correspondentRepo = lazy(() => new CorrespondentRepository(db));
  const employerNoteRepo = lazy(() => new EmployerNoteRepository(db));
  const topicRepo = lazy(() => new TopicRepository(db));
  const emailRepo = lazy(() => new EmailRepository(db));
  const employerTeamRepo = lazy(() => new EmployerTeamRepository(db));
  const employerCurationRepo = lazy(() => new EmployerCurationRepository(db));
  const correspondentCurationRepo = lazy(() => new CorrespondentCurationRepository(db));
  const employerRelatedCompanyRepo = lazy(() => new EmployerRelatedCompanyRepository(db));
  const workspaceCorrespondentRepo = lazy(() => new WorkspaceCorrespondentRepository(db));
  const crmService = lazy(
    () =>
      new CRMService(
        employerRepo(),
        correspondentRepo(),
        employerNoteRepo(),
        topicRepo(),
        emailRepo(),
        employerTeamRepo(),
        employerCurationRepo(),
        correspondentCurationRepo(),
        employerRelatedCompanyRepo(),
        companyRepo(),
        workspaceCorrespondentRepo(),
        workspaceId,
      ),
  );

  const crmContactEnrichmentService = lazy(
    () =>
      new CrmContactEnrichmentService(correspondentRepo(), employerRepo(), db, workspaceId),
  );

  const companyContactDiscoveryService = lazy(
    () =>
      new CompanyContactDiscoveryService(
        companyRepo(),
        employerRepo(),
        new EmployerDomainRepository(db),
        correspondentRepo(),
        crmService(),
        db,
        workspaceId,
      ),
  );

  const aiWorkforceQueueRepo = lazy(() => new AiWorkforceQueueRepository(db, workspaceId));
  const aiWorkforceService = lazy(
    () => new AiWorkforceService(aiWorkforceQueueRepo(), db, new AgentCheckpointRepository(db)),
  );
  const notificationService = lazy(() => new NotificationService(aiWorkforceQueueRepo()));

  const copilotChatsRepo = lazy(() => new CopilotChatsRepository(db, workspaceId));
  const copilotChatsService = lazy(() => new CopilotChatsService(copilotChatsRepo()));

  const alphasenseToolCallRepo = lazy(() => new AlphasenseToolCallRepository(db, workspaceId));
  const alphasenseToolCallService = lazy(
    () => new AlphasenseToolCallService(alphasenseToolCallRepo()),
  );

  const dashboardActivityRepo = lazy(() => new DashboardActivityRepository(db, workspaceId));
  const dashboardActivityService = lazy(
    () => new DashboardActivityService(dashboardActivityRepo(), pipelineStageRepo()),
  );

  const dashboardInsightsRepo = lazy(() => new DashboardInsightsRepository(db, workspaceId));
  const appSettingsRepo = lazy(() => new AppSettingsRepository(db));
  const dashboardInsightsService = lazy(
    () =>
      new DashboardInsightsService(
        dashboardInsightsRepo(),
        appSettingsRepo(),
        thesisRepo(),
        pipelineStageRepo(),
      ),
  );

  const apiKeyRepo = lazy(() => new ApiKeyRepository(db));
  const apiKeyService = lazy(() => new ApiKeyService(apiKeyRepo()));

  const apiChatConversationRepo = lazy(() => new ApiChatConversationRepository(db, workspaceId));
  const apiChatConversationService = lazy(
    () => new ApiChatConversationService(apiChatConversationRepo()),
  );

  const dealResurfaceService = lazy(
    () =>
      new DealResurfaceService(
        companyRepo(),
        companyLogRepo(),
        dealNoteRepo(),
        userRepo(),
        thesisRepo(),
        undefined,
        undefined,
        pipelineStageRepo(),
      ),
  );

  const chatAttachmentService = lazy(() => new ChatAttachmentService(workspaceId));

  const stalledDealService = lazy(
    () => new StalledDealService(companyRepo(), companyLogRepo(), pipelineStageRepo()),
  );

  const dailyPulseRepo = lazy(() => new DailyPulseRepository(db, workspaceId));
  const dailyPulseService = lazy(() => new DailyPulseService(workspaceId, dailyPulseRepo()));

  const featureFlagRepo = lazy(() => new FeatureFlagRepository(db));
  const featureFlagsService = lazy(() => new FeatureFlagsService(featureFlagRepo()));

  const tableLayoutRepo = lazy(() => new WorkspaceTableLayoutRepository(db, workspaceId));
  const tableLayoutService = lazy(() => new TableLayoutService(tableLayoutRepo()));

  const feedbackRepo = lazy(() => new FeedbackRepository(db, workspaceId));
  const feedbackService = lazy(
    () => new FeedbackService(feedbackRepo(), userRepo(), workspaceRepo(), workspaceId),
  );

  // Global (non-workspace-scoped): the RSS feed catalog is shared by every
  // workspace, so the repo takes no workspaceId.
  const rssFeedRepo = lazy(() => new RssFeedRepository(db));
  const rssFeedService = lazy(() => new RssFeedService(rssFeedRepo()));

  const rssItemRepo = lazy(() => new RssItemRepository(db));
  const rssItemChunkRepo = lazy(() => new RssItemChunkRepository(db));
  const dataNavigatorService = lazy(
    () =>
      new DataNavigatorService(rssItemRepo(), rssItemChunkRepo(), new BedrockEmbeddingClient()),
  );

  const userConsentRepo = lazy(() => new UserConsentRepository(db));
  const consentService = lazy(
    () => new ConsentService(userConsentRepo(), userRepo(), userWorkspaceRepo()),
  );
  const flInvestorRepo = lazy(() => new FlInvestorRepository(db));
  const flFundRepo = lazy(() => new FlFundRepository(db));
  const flAssetRepo = lazy(() => new FlAssetRepository(db));
  const flFundingSourceRepo = lazy(() => new FlFundingSourceRepository(db));
  const flPositionRepo = lazy(() => new FlPositionRepository(db));
  const flBusinessEventRepo = lazy(() => new FlBusinessEventRepository(db));
  const flBusinessEventRevisionRepo = lazy(() => new FlBusinessEventRevisionRepository(db));
  const flLedgerEntryRepo = lazy(() => new FlLedgerEntryRepository(db));
  const flAllocationRepo = lazy(() => new FlAllocationRepository(db));
  const flValuationRepo = lazy(() => new FlValuationRepository(db));
  const flSourceRecordRepo = lazy(() => new FlSourceRecordRepository(db));
  const flCorporateActionRepo = lazy(() => new FlCorporateActionRepository(db));

  const flMasterDataService = lazy(
    () =>
      new FlMasterDataService(
        db,
        flInvestorRepo(),
        flFundRepo(),
        flAssetRepo(),
        flFundingSourceRepo(),
      ),
  );
  const flInvestmentTypeService = lazy(
    () => new FlInvestmentTypeService(db, new FlInvestmentTypeRepository(db), flAssetRepo()),
  );
  const flPositionService = lazy(
    () =>
      new FlPositionService(
        db,
        flPositionRepo(),
        flInvestorRepo(),
        flFundRepo(),
        flAssetRepo(),
        flLedgerEntryRepo(),
        flFundingSourceRepo(),
        flMasterDataService(),
      ),
  );
  const flLedgerService = lazy(
    () =>
      new FlLedgerService(
        db,
        flLedgerEntryRepo(),
        flBusinessEventRepo(),
        flAllocationRepo(),
        flPositionRepo(),
        flFundingSourceRepo(),
        flSourceRecordRepo(),
        flAssetRepo(),
        flFundRepo(),
        flMasterDataService(),
        flPositionService(),
        flInvestorRepo(),
        flBusinessEventRevisionRepo(),
      ),
  );
  const flValuationService = lazy(
    () =>
      new FlValuationService(
        db,
        flValuationRepo(),
        flAssetRepo(),
        flFundRepo(),
        flPositionRepo(),
        flSourceRecordRepo(),
      ),
  );
  const flCorporateActionService = lazy(
    () =>
      new FlCorporateActionService(
        db,
        flCorporateActionRepo(),
        flValuationRepo(),
        flPositionRepo(),
        flAssetRepo(),
        flFundRepo(),
        flInvestorRepo(),
        flLedgerEntryRepo(),
      ),
  );
  const flBalanceService = lazy(
    () =>
      new FlBalanceService(
        db,
        flLedgerEntryRepo(),
        flPositionRepo(),
        flFundRepo(),
        flAssetRepo(),
        flValuationRepo(),
      ),
  );
  const flPortfolioService = lazy(
    () =>
      new FlPortfolioService(
        db,
        flFundRepo(),
        flAssetRepo(),
        flPositionRepo(),
        flInvestorRepo(),
        flFundingSourceRepo(),
        flBusinessEventRepo(),
        flLedgerEntryRepo(),
        flAllocationRepo(),
        flValuationRepo(),
        flBalanceService(),
      ),
  );

  const fundUpdateApplyService = lazy(
    () =>
      new FundUpdateApplyService(
        db,
        workspaceId,
        flFundRepo(),
        flAssetRepo(),
        flPositionRepo(),
        flInvestorRepo(),
        flFundingSourceRepo(),
        flMasterDataService(),
        flPositionService(),
        flLedgerService(),
        flValuationService(),
        flValuationRepo(),
        flLedgerEntryRepo(),
        flSourceRecordRepo(),
        flAllocationRepo(),
      ),
  );
  const fundCatalogCheckService = lazy(
    () =>
      new FundCatalogCheckService(
        workspaceId,
        flFundRepo(),
        flPositionRepo(),
        flAssetRepo(),
        flBalanceService(),
      ),
  );
  const fundAiOpinionService = lazy(
    () =>
      new FundAiOpinionService(
        flAssetRepo(),
        flValuationRepo(),
        db,
        workspaceId,
        flPositionRepo(),
        flBalanceService(),
      ),
  );

  const insightRepo = lazy(() => new InsightRepository(db));
  const insightVersionRepo = lazy(() => new InsightVersionRepository(db));
  const insightRunDraftRepo = lazy(() => new InsightRunDraftRepository(db));
  const insightTemplateRepo = lazy(() => new InsightTemplateRepository(db, workspaceId));
  const insightService = lazy(
    () =>
      new InsightService(
        insightRepo(),
        insightVersionRepo(),
        insightRunDraftRepo(),
        db,
        undefined, // the shipped sector registry (the default)
        routinesRepo(),
        insightTemplateRepo(),
      ),
  );

  const insightTemplateService = lazy(
    () => new InsightTemplateService(insightTemplateRepo(), insightRepo(), workspaceId),
  );

  const profileService = lazy(
    () =>
      new ProfileService(
        companyRepo(),
        insightRepo(),
        companyVoteRepo(),
        aiWorkforceQueueRepo(),
        workspaceId,
      ),
  );

  // The one repository here that is NOT workspace-scoped: a memory belongs to
  // a person and follows them across workspaces. The workspace is passed only
  // so a new memory records where it was formed.
  const userMemoryRepo = lazy(() => new UserMemoryRepository(db, workspaceId));
  const userMemoryService = (userId: string) =>
    new UserMemoryService(userMemoryRepo(), userRepo(), userId);

  const userProfileService = lazy(() => new UserProfileService(userRepo()));

  const routineService = lazy(
    () =>
      new RoutineService(
        routinesRepo(),
        insightRepo(),
        workspaceId,
        undefined, // the shipped sector registry (the default)
        (input) => enqueueAgentRun(db, input),
      ),
  );

  const interventionRecipientService = lazy(
    () =>
      new InterventionRecipientService(insightRepo(), routinesRepo(), userWorkspaceRepo()),
  );

  return {
    get companyService() { return companyService(); },
    get companyGraphService() { return companyGraphService(); },
    get companyRelationshipService() { return companyRelationshipService(); },
    get screeningService() { return screeningService(); },
    get clientHealthService() { return clientHealthService(); },
    get criteriaService() { return criteriaService(); },
    get investmentThesisService() { return investmentThesisService(); },
    get trackVariableService() { return trackVariableService(); },
    get pipelineStageService() { return pipelineStageService(); },
    get marketScanningRoutineService() { return marketScanningRoutineService(); },
    get dealDocumentService() { return dealDocumentService(); },
    get recentFileService() { return recentFileService(); },
    get userTaskService() { return userTaskService(); },
    get dealNoteService() { return dealNoteService(); },
    get dealLinkService() { return dealLinkService(); },
    get companyAnalysisService() { return companyAnalysisService(); },
    get aiOpinionService() { return aiOpinionService(); },
    get aiScreeningService() { return aiScreeningService(); },
    get marketScreeningService() { return marketScreeningService(); },
    get trackMatchingService() { return trackMatchingService(); },
    get pendingAutoScanService() { return pendingAutoScanService(); },
    get slideService() { return slideService(); },
    get companyCardSlideService() { return companyCardSlideService(); },
    get companyVoteService() { return companyVoteService(); },
    get fileService() { return fileService(); },
    get chatService() { return chatService(); },
    get jobService() { return jobService(); },
    get authService() { return authService(); },
    get userService() { return userService(); },
    get crmService() { return crmService(); },
    get crmContactEnrichmentService() { return crmContactEnrichmentService(); },
    get companyContactDiscoveryService() { return companyContactDiscoveryService(); },
    get aiWorkforceService() { return aiWorkforceService(); },
    get copilotChatsService() { return copilotChatsService(); },
    get alphasenseToolCallService() { return alphasenseToolCallService(); },
    get dashboardActivityService() { return dashboardActivityService(); },
    get dashboardInsightsService() { return dashboardInsightsService(); },
    get dailyPulseService() { return dailyPulseService(); },
    get apiKeyService() { return apiKeyService(); },
    get apiChatConversationService() { return apiChatConversationService(); },
    get notificationService() { return notificationService(); },
    get workspaceService() { return workspaceService(); },
    get dealResurfaceService() { return dealResurfaceService(); },
    get chatAttachmentService() { return chatAttachmentService(); },
    get fundUpdateApplyService() { return fundUpdateApplyService(); },
    get fundCatalogCheckService() { return fundCatalogCheckService(); },
    get fundAiOpinionService() { return fundAiOpinionService(); },
    get stalledDealService() { return stalledDealService(); },
    get featureFlagsService() { return featureFlagsService(); },
    get feedbackService() { return feedbackService(); },
    get tableLayoutService() { return tableLayoutService(); },
    get rssFeedService() { return rssFeedService(); },
    get dataNavigatorService() { return dataNavigatorService(); },
    get consentService() { return consentService(); },
    get flMasterDataService() { return flMasterDataService(); },
    get flInvestmentTypeService() { return flInvestmentTypeService(); },
    get flPositionService() { return flPositionService(); },
    get flLedgerService() { return flLedgerService(); },
    get flValuationService() { return flValuationService(); },
    get flCorporateActionService() { return flCorporateActionService(); },
    get flBalanceService() { return flBalanceService(); },
    get flPortfolioService() { return flPortfolioService(); },
    get insightService() { return insightService(); },
    get profileService() { return profileService(); },
    userMemoryService,
    get userProfileService() { return userProfileService(); },
    get interventionRecipientService() { return interventionRecipientService(); },
    get insightTemplateService() { return insightTemplateService(); },
    get routineService() { return routineService(); },
  };
}
