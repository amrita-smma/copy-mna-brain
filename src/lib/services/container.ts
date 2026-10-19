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

export function createContainer(db: DbClient, workspaceId: string): Container {
  const jobDispatcher = new JobDispatcher(db, createDb, workspaceId);

  // Neo4j mirror: the relationship-graph repo doubles as the write-through
  // mirror for company writes. The driver is a cached global singleton and is
  // only touched when a company is actually written, so wiring it in adds no
  // cost to graph-less requests. Postgres stays the source of truth — Neo4j
  // follows every insert/update/delete that flows through CompanyRepository.
  const companyGraphRepo = new CompanyRelationRepository(createNeo4jDriver());

  const companyRepo = new CompanyRepository(db, workspaceId, companyGraphRepo);
  const companyLogRepo = new CompanyLogRepository(db, workspaceId);
  const screeningRepo = new ScreeningRepository(db, workspaceId);
  const criteriaRepo = new CriteriaRepository(db, workspaceId);
  const dealDocRepo = new DealDocumentRepository(db, workspaceId);
  const dealNoteRepo = new DealNoteRepository(db, workspaceId);
  const dealLinkRepo = new DealLinkRepository(db, workspaceId);
  const companyAnalysisRepo = new CompanyAnalysisRepository(db, workspaceId);
  const companySlidesRepo = new CompanySlidesRepository(db, workspaceId);
  const fileRepo = new FileRepository(db, workspaceId);
  const thesisRepo = new InvestmentThesisRepository(db, workspaceId);
  const trackVariableRepo = new TrackVariableRepository(db, workspaceId);
  const pipelineStageRepo = new PipelineStageRepository(db, workspaceId);
  const jobRepo = new JobRepository(db);
  const userRepo = new UserRepository(db);
  const resetTokenRepo = new ResetPasswordTokenRepository(db);
  const recentFileRepo = new RecentFileRepository(db, workspaceId);
  const companyFinancialRepo = new CompanyFinancialRepository(db, workspaceId);
  const companyFxAdjustmentRepo = new CompanyFxAdjustmentRepository(db, workspaceId);
  const companyScreeningDerivedRepo = new CompanyScreeningDerivedRepository(db, workspaceId);
  const userWorkspaceRepo = new UserWorkspaceRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const roleRepo = new RoleRepository(db);

  const criteriaService = new CriteriaService(criteriaRepo);
  const screeningService = new ScreeningService(screeningRepo, workspaceId);
  const clientHealthService = new ClientHealthService(workspaceId);
  const routinesRepo = new RoutinesRepository(db, workspaceId);
  const marketScanningRoutineService = new MarketScanningRoutineService(routinesRepo);
  const investmentThesisService = new InvestmentThesisService(
    thesisRepo,
    marketScanningRoutineService,
  );
  const trackVariableService = new TrackVariableService(trackVariableRepo);
  const dealNoteService = new DealNoteService(dealNoteRepo);
  const dealLinkService = new DealLinkService(dealLinkRepo);
  const jobService = new JobService(jobRepo, db);
  const authService = new AuthService(userRepo, resetTokenRepo);
  const userService = new UserService(userRepo, workspaceId, authService);
  const chatService = new ChatService(thesisRepo, criteriaRepo);
  const workspaceService = new WorkspaceService(workspaceRepo, userWorkspaceRepo, roleRepo, userRepo);

  const companyAnalysisService = new CompanyAnalysisService(companyAnalysisRepo, companyRepo, db, workspaceId);
  const aiOpinionService = new AiOpinionService(companyRepo, db, workspaceId);
  const aiWorkforceQueueRepo = new AiWorkforceQueueRepository(db, workspaceId);
  const aiScreeningService = new AIScreeningService(
    db,
    workspaceId,
    companyRepo,
    screeningRepo,
    criteriaRepo,
    thesisRepo,
    screeningService,
    aiWorkforceQueueRepo,
  );
  const marketScreeningService = new MarketScreeningService(jobDispatcher);
  const trackMatchingService = new TrackMatchingService(jobDispatcher, db, workspaceId);
  const slideService = new SlideService(companySlidesRepo, jobDispatcher);

  const companyService = new CompanyService(
    workspaceId,
    companyRepo,
    companyLogRepo,
    dealDocRepo,
    dealNoteRepo,
    dealLinkRepo,
    companyFinancialRepo,
    companyFxAdjustmentRepo,
    companyScreeningDerivedRepo,
    trackMatchingService,
    userRepo,
    fileRepo,
    // A pipeline stage move regenerates the AI Company Card against the latest
    // information (see CompanyService.promote / promoteMany / updateFromDTO).
    companyAnalysisService,
    pipelineStageRepo,
  );
  const pipelineStageService = new PipelineStageService(
    pipelineStageRepo,
    companyRepo,
    companyService,
  );
  const companyCardSlideService = new CompanyCardSlideService(
    companyService,
    companyAnalysisService,
    investmentThesisService,
    trackVariableService,
    workspaceService,
    workspaceId,
    pipelineStageRepo,
  );
  const companyVoteRepo = new CompanyVoteRepository(db, workspaceId);
  const companyVoteService = new CompanyVoteService(
    companyVoteRepo,
    userRepo,
    companyRepo,
    workspaceRepo,
    companyCardSlideService,
    aiOpinionService,
    jobDispatcher,
    workspaceId,
  );
  const companyGraphService = new CompanyGraphService(companyGraphRepo, jobDispatcher);
  const companyRelationshipService = new CompanyRelationshipService(
    companyRepo,
    companyService,
    companyGraphService,
  );
  const dealDocumentService = new DealDocumentService(dealDocRepo, jobDispatcher, workspaceId);
  const recentFileService = new RecentFileService(recentFileRepo);
  const userTaskService = new UserTaskService(
    new UserTaskRepository(db, workspaceId),
    userRepo,
    workspaceRepo,
    workspaceId,
  );
  const fileService = new FileService(
    db,
    workspaceId,
    fileRepo,
    companyAnalysisService,
    aiScreeningService,
    criteriaRepo,
    screeningRepo,
    companyFinancialRepo,
    companyService,
    companyFxAdjustmentRepo,
    userWorkspaceRepo,
    trackMatchingService,
    userRepo,
  );
  fileService.setWorkspaceRepo(workspaceRepo);

  const pendingAutoScanService = new PendingAutoScanService(
    workspaceId,
    companyRepo,
    screeningRepo,
    workspaceService,
    companyService,
    aiScreeningService,
    trackMatchingService,
  );
  // Setters, not constructor args: PendingAutoScanService depends on both.
  companyService.setPendingArrivalHandler((companyIds, triggeredByUserId) =>
    pendingAutoScanService.onCompaniesEnteredPending(companyIds, triggeredByUserId),
  );
  fileService.setPendingAutoScanService(pendingAutoScanService);

  const employerRepo = new EmployerRepository(db);
  const correspondentRepo = new CorrespondentRepository(db);
  const employerNoteRepo = new EmployerNoteRepository(db);
  const topicRepo = new TopicRepository(db);
  const emailRepo = new EmailRepository(db);
  const employerTeamRepo = new EmployerTeamRepository(db);
  const employerCurationRepo = new EmployerCurationRepository(db);
  const correspondentCurationRepo = new CorrespondentCurationRepository(db);
  const employerRelatedCompanyRepo = new EmployerRelatedCompanyRepository(db);
  const workspaceCorrespondentRepo = new WorkspaceCorrespondentRepository(db);
  const crmService = new CRMService(
    employerRepo,
    correspondentRepo,
    employerNoteRepo,
    topicRepo,
    emailRepo,
    employerTeamRepo,
    employerCurationRepo,
    correspondentCurationRepo,
    employerRelatedCompanyRepo,
    companyRepo,
    workspaceCorrespondentRepo,
    workspaceId,
  );
  const crmContactEnrichmentService = new CrmContactEnrichmentService(
    correspondentRepo,
    employerRepo,
    db,
    workspaceId,
  );
  const companyContactDiscoveryService = new CompanyContactDiscoveryService(
    companyRepo,
    employerRepo,
    new EmployerDomainRepository(db),
    correspondentRepo,
    crmService,
    db,
    workspaceId,
  );

  const aiWorkforceService = new AiWorkforceService(aiWorkforceQueueRepo, db, new AgentCheckpointRepository(db));
  const notificationService = new NotificationService(aiWorkforceQueueRepo);

  const copilotChatsRepo = new CopilotChatsRepository(db, workspaceId);
  const copilotChatsService = new CopilotChatsService(copilotChatsRepo);

  const alphasenseToolCallRepo = new AlphasenseToolCallRepository(db, workspaceId);
  const alphasenseToolCallService = new AlphasenseToolCallService(alphasenseToolCallRepo);

  const dashboardActivityRepo = new DashboardActivityRepository(db, workspaceId);
  const dashboardActivityService = new DashboardActivityService(dashboardActivityRepo, pipelineStageRepo);

  const dashboardInsightsRepo = new DashboardInsightsRepository(db, workspaceId);
  const appSettingsRepo = new AppSettingsRepository(db);
  const dashboardInsightsService = new DashboardInsightsService(
    dashboardInsightsRepo,
    appSettingsRepo,
    thesisRepo,
    pipelineStageRepo,
  );

  const apiKeyRepo = new ApiKeyRepository(db);
  const apiKeyService = new ApiKeyService(apiKeyRepo);

  const apiChatConversationRepo = new ApiChatConversationRepository(db, workspaceId);
  const apiChatConversationService = new ApiChatConversationService(apiChatConversationRepo);

  const dealResurfaceService = new DealResurfaceService(
    companyRepo,
    companyLogRepo,
    dealNoteRepo,
    userRepo,
    thesisRepo,
    undefined,
    undefined,
    pipelineStageRepo,
  );

  fileService.setCRMService(crmService);
  fileService.setJobDispatcher(jobDispatcher);

  const chatAttachmentService = new ChatAttachmentService(workspaceId);



  const stalledDealService = new StalledDealService(companyRepo, companyLogRepo, pipelineStageRepo);

  const dailyPulseRepo = new DailyPulseRepository(db, workspaceId);
  const dailyPulseService = new DailyPulseService(workspaceId, dailyPulseRepo);

  const featureFlagRepo = new FeatureFlagRepository(db);
  const featureFlagsService = new FeatureFlagsService(featureFlagRepo);

  const tableLayoutRepo = new WorkspaceTableLayoutRepository(db, workspaceId);
  const tableLayoutService = new TableLayoutService(tableLayoutRepo);

  const feedbackRepo = new FeedbackRepository(db, workspaceId);
  const feedbackService = new FeedbackService(feedbackRepo, userRepo, workspaceRepo, workspaceId);

  // Global (non-workspace-scoped): the RSS feed catalog is shared by every
  // workspace, so the repo takes no workspaceId.
  const rssFeedRepo = new RssFeedRepository(db);
  const rssFeedService = new RssFeedService(rssFeedRepo);

  const rssItemRepo = new RssItemRepository(db);
  const rssItemChunkRepo = new RssItemChunkRepository(db);
  const dataNavigatorService = new DataNavigatorService(
    rssItemRepo,
    rssItemChunkRepo,
    new BedrockEmbeddingClient(),
  );

  const userConsentRepo = new UserConsentRepository(db);
  const consentService = new ConsentService(userConsentRepo, userRepo, userWorkspaceRepo);
  const flInvestorRepo = new FlInvestorRepository(db);
  const flFundRepo = new FlFundRepository(db);
  const flAssetRepo = new FlAssetRepository(db);
  const flFundingSourceRepo = new FlFundingSourceRepository(db);
  const flPositionRepo = new FlPositionRepository(db);
  const flBusinessEventRepo = new FlBusinessEventRepository(db);
  const flBusinessEventRevisionRepo = new FlBusinessEventRevisionRepository(db);
  const flLedgerEntryRepo = new FlLedgerEntryRepository(db);
  const flAllocationRepo = new FlAllocationRepository(db);
  const flValuationRepo = new FlValuationRepository(db);
  const flSourceRecordRepo = new FlSourceRecordRepository(db);
  const flCorporateActionRepo = new FlCorporateActionRepository(db);

  const flMasterDataService = new FlMasterDataService(
    db,
    flInvestorRepo,
    flFundRepo,
    flAssetRepo,
    flFundingSourceRepo,
  );
  const flPositionService = new FlPositionService(
    db,
    flPositionRepo,
    flInvestorRepo,
    flFundRepo,
    flAssetRepo,
    flLedgerEntryRepo,
    flFundingSourceRepo,
    flMasterDataService,
  );
  const flLedgerService = new FlLedgerService(
    db,
    flLedgerEntryRepo,
    flBusinessEventRepo,
    flAllocationRepo,
    flPositionRepo,
    flFundingSourceRepo,
    flSourceRecordRepo,
    flAssetRepo,
    flFundRepo,
    flMasterDataService,
    flPositionService,
    flInvestorRepo,
    flBusinessEventRevisionRepo,
  );
  const flValuationService = new FlValuationService(
    db,
    flValuationRepo,
    flAssetRepo,
    flFundRepo,
    flPositionRepo,
    flSourceRecordRepo,
  );
  const flCorporateActionService = new FlCorporateActionService(
    db,
    flCorporateActionRepo,
    flValuationRepo,
    flPositionRepo,
    flAssetRepo,
    flFundRepo,
    flInvestorRepo,
    flLedgerEntryRepo,
  );
  const flBalanceService = new FlBalanceService(
    db,
    flLedgerEntryRepo,
    flPositionRepo,
    flFundRepo,
    flAssetRepo,
    flValuationRepo,
  );
  const flPortfolioService = new FlPortfolioService(
    db,
    flFundRepo,
    flAssetRepo,
    flPositionRepo,
    flInvestorRepo,
    flFundingSourceRepo,
    flBusinessEventRepo,
    flLedgerEntryRepo,
    flAllocationRepo,
    flValuationRepo,
    flBalanceService,
  );

  const fundUpdateApplyService = new FundUpdateApplyService(
    db,
    workspaceId,
    flFundRepo,
    flAssetRepo,
    flPositionRepo,
    flInvestorRepo,
    flFundingSourceRepo,
    flMasterDataService,
    flPositionService,
    flLedgerService,
    flValuationService,
    flValuationRepo,
    flLedgerEntryRepo,
    flSourceRecordRepo,
    flAllocationRepo,
  );
  fileService.setFundUpdateApplyService(fundUpdateApplyService);
  const fundCatalogCheckService = new FundCatalogCheckService(
    workspaceId,
    flFundRepo,
    flPositionRepo,
    flAssetRepo,
    flBalanceService,
  );
  fileService.setFundCatalogCheckService(fundCatalogCheckService);
  const fundAiOpinionService = new FundAiOpinionService(
    flAssetRepo,
    flValuationRepo,
    db,
    workspaceId,
    flPositionRepo,
    flBalanceService,
  );

  const insightRepo = new InsightRepository(db);
  const insightVersionRepo = new InsightVersionRepository(db);
  const insightRunDraftRepo = new InsightRunDraftRepository(db);
  const insightTemplateRepo = new InsightTemplateRepository(db, workspaceId);
  const insightService = new InsightService(
    insightRepo,
    insightVersionRepo,
    insightRunDraftRepo,
    db,
    undefined, // the shipped sector registry (the default)
    routinesRepo,
    insightTemplateRepo,
  );

  const insightTemplateService = new InsightTemplateService(
    insightTemplateRepo,
    insightRepo,
    workspaceId,
  );

  const profileService = new ProfileService(
    companyRepo,
    insightRepo,
    companyVoteRepo,
    aiWorkforceQueueRepo,
    workspaceId,
  );

  // The one repository here that is NOT workspace-scoped: a memory belongs to
  // a person and follows them across workspaces. The workspace is passed only
  // so a new memory records where it was formed.
  const userMemoryRepo = new UserMemoryRepository(db, workspaceId);
  const userMemoryService = (userId: string) =>
    new UserMemoryService(userMemoryRepo, userRepo, userId);

  const userProfileService = new UserProfileService(userRepo);

  const routineService = new RoutineService(
    routinesRepo,
    insightRepo,
    workspaceId,
    undefined, // the shipped sector registry (the default)
    (input) => enqueueAgentRun(db, input),
  );

  const interventionRecipientService = new InterventionRecipientService(
    insightRepo,
    routinesRepo,
    userWorkspaceRepo,
  );

  return {
    companyService,
    companyGraphService,
    companyRelationshipService,
    screeningService,
    clientHealthService,
    criteriaService,
    investmentThesisService,
    trackVariableService,
    pipelineStageService,
    marketScanningRoutineService,
    dealDocumentService,
    recentFileService,
    userTaskService,
    dealNoteService,
    dealLinkService,
    companyAnalysisService,
    aiOpinionService,
    aiScreeningService,
    marketScreeningService,
    trackMatchingService,
    pendingAutoScanService,
    slideService,
    companyCardSlideService,
    companyVoteService,
    fileService,
    chatService,
    jobService,
    authService,
    userService,
    crmService,
    crmContactEnrichmentService,
    companyContactDiscoveryService,
    aiWorkforceService,
    copilotChatsService,
    alphasenseToolCallService,
    dashboardActivityService,
    dashboardInsightsService,
    dailyPulseService,
    apiKeyService,
    apiChatConversationService,
    notificationService,
    workspaceService,
    dealResurfaceService,
    chatAttachmentService,
    fundUpdateApplyService,
    fundCatalogCheckService,
    fundAiOpinionService,
    stalledDealService,
    featureFlagsService,
    feedbackService,
    tableLayoutService,
    rssFeedService,
    dataNavigatorService,
    consentService,
    flMasterDataService,
    flPositionService,
    flLedgerService,
    flValuationService,
    flCorporateActionService,
    flBalanceService,
    flPortfolioService,
    insightService,
    profileService,
    userMemoryService,
    userProfileService,
    interventionRecipientService,
    insightTemplateService,
    routineService,
  };
}
