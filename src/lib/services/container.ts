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
  FileRepository,
  InvestmentThesisRepository,
  TrackVariableRepository,
  JobRepository,
  ResetPasswordTokenRepository,
  UserRepository,
  RecentFileRepository,
  EmployerRepository,
  EmployerCurationRepository,
  EmployerRelatedCompanyRepository,
  CorrespondentRepository,
  CorrespondentCurationRepository,
  EmployerNoteRepository,
  TopicRepository,
  EmailRepository,
  EmployerTeamRepository,
  AiWorkforceQueueRepository,
  CopilotChatsRepository,
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
  FundRepository,
  HoldingEntityRepository,
  FundSourceRepository,
  FundHoldingEntityStakeRepository,
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FeedbackRepository,
} from '@/lib/repositories';
import { JobDispatcher } from './jobDispatcher';
import { CompanyService } from './companyService';
import { CompanyGraphService } from './companyGraphService';
import { CompanyRelationshipService } from './companyRelationshipService';
import { createNeo4jDriver } from '@/lib/neo4j';
import { CompanyRelationRepository } from '@/lib/repositories/companyRelationRepository';
import { ScreeningService } from './screeningService';
import { CriteriaService } from './criteriaService';
import { InvestmentThesisService } from './investmentThesisService';
import { TrackVariableService } from './trackVariableService';
import { MarketScanningRoutineService } from './marketScanningRoutineService';
import { DealDocumentService } from './dealDocumentService';
import { RecentFileService } from './recentFileService';
import { DealNoteService } from './dealNoteService';
import { DealLinkService } from './dealLinkService';
import { CompanyAnalysisService } from './companyAnalysisService';
import { AiOpinionService } from './aiOpinionService';
import { FundAiOpinionService } from './fundAiOpinionService';
import { AIScreeningService } from './aiScreeningService';
import { MarketScreeningService } from './marketScreeningService';
import { TrackMatchingService } from './trackMatchingService';
import { SlideService } from './slideService';
import { CompanyCardSlideService } from './companyCardSlideService';
import { FileService } from './fileService';
import { ChatService } from './chatService';
import { JobService } from './jobService';
import { AuthService } from './authService';
import { UserService } from './userService';
import { CRMService } from './crmService';
import { AiWorkforceService } from './aiWorkforceService';
import { CopilotChatsService } from './copilotChatsService';
import { DashboardActivityService } from './dashboardActivityService';
import { DashboardInsightsService } from './dashboardInsightsService';
import { DailyPulseService } from './dailyPulseService';
import { ApiKeyService } from './apiKeyService';
import { ApiChatConversationService } from './apiChatConversationService';
import { NotificationService } from './notificationService';
import { WorkspaceService } from './workspaceService';
import { DealResurfaceService } from './dealResurfaceService';
import { ChatAttachmentService } from './chatAttachmentService';
import { FundService } from './fundService';
import { HoldingEntityService } from './holdingEntityService';
import { FundSourceService } from './fundSourceService';
import { FundHoldingEntityStakeService } from './fundHoldingEntityStakeService';
import { FundAssetLedgerService } from './fundAssetLedgerService';
import { FundUpdateApplyService } from './fundUpdateApplyService';
import { FundPortfolioService } from './fundPortfolioService';
import { FundMetricsService } from './fundMetricsService';
import { StalledDealService } from './stalledDealService';
import { FeatureFlagsService } from './featureFlagsService';
import { TableLayoutService } from './tableLayoutService';
import { FeedbackService } from './feedbackService';

export interface Container {
  companyService: CompanyService;
  companyGraphService: CompanyGraphService;
  companyRelationshipService: CompanyRelationshipService;
  screeningService: ScreeningService;
  criteriaService: CriteriaService;
  investmentThesisService: InvestmentThesisService;
  trackVariableService: TrackVariableService;
  marketScanningRoutineService: MarketScanningRoutineService;
  dealDocumentService: DealDocumentService;
  recentFileService: RecentFileService;
  dealNoteService: DealNoteService;
  dealLinkService: DealLinkService;
  companyAnalysisService: CompanyAnalysisService;
  aiOpinionService: AiOpinionService;
  aiScreeningService: AIScreeningService;
  marketScreeningService: MarketScreeningService;
  trackMatchingService: TrackMatchingService;
  slideService: SlideService;
  companyCardSlideService: CompanyCardSlideService;
  fileService: FileService;
  chatService: ChatService;
  jobService: JobService;
  authService: AuthService;
  userService: UserService;
  crmService: CRMService;
  aiWorkforceService: AiWorkforceService;
  copilotChatsService: CopilotChatsService;
  dashboardActivityService: DashboardActivityService;
  dashboardInsightsService: DashboardInsightsService;
  dailyPulseService: DailyPulseService;
  apiKeyService: ApiKeyService;
  apiChatConversationService: ApiChatConversationService;
  notificationService: NotificationService;
  workspaceService: WorkspaceService;
  dealResurfaceService: DealResurfaceService;
  chatAttachmentService: ChatAttachmentService;
  fundService: FundService;
  holdingEntityService: HoldingEntityService;
  fundSourceService: FundSourceService;
  fundHoldingEntityStakeService: FundHoldingEntityStakeService;
  fundAssetLedgerService: FundAssetLedgerService;
  fundUpdateApplyService: FundUpdateApplyService;
  fundPortfolioService: FundPortfolioService;
  fundMetricsService: FundMetricsService;
  fundAiOpinionService: FundAiOpinionService;
  stalledDealService: StalledDealService;
  featureFlagsService: FeatureFlagsService;
  feedbackService: FeedbackService;
  tableLayoutService: TableLayoutService;
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
  const screeningService = new ScreeningService(screeningRepo);
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
  const userService = new UserService(userRepo);
  const chatService = new ChatService(thesisRepo, criteriaRepo);
  const workspaceService = new WorkspaceService(workspaceRepo, userWorkspaceRepo, roleRepo, userRepo);

  const companyAnalysisService = new CompanyAnalysisService(companyAnalysisRepo, companyRepo, db, workspaceId);
  const aiOpinionService = new AiOpinionService(companyRepo, db, workspaceId);
  const aiScreeningService = new AIScreeningService(screeningRepo, jobDispatcher);
  const marketScreeningService = new MarketScreeningService(jobDispatcher);
  const trackMatchingService = new TrackMatchingService(jobDispatcher, db, workspaceId);
  const slideService = new SlideService(companySlidesRepo, jobDispatcher);

  const companyService = new CompanyService(
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
  );
  const companyCardSlideService = new CompanyCardSlideService(
    companyService,
    companyAnalysisService,
    investmentThesisService,
    trackVariableService,
    workspaceService,
    workspaceId,
  );
  const companyGraphService = new CompanyGraphService(companyGraphRepo, jobDispatcher);
  const companyRelationshipService = new CompanyRelationshipService(
    companyRepo,
    companyService,
    companyGraphService,
  );
  const dealDocumentService = new DealDocumentService(dealDocRepo);
  const recentFileService = new RecentFileService(recentFileRepo);
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

  const aiWorkforceQueueRepo = new AiWorkforceQueueRepository(db, workspaceId);
  const aiWorkforceService = new AiWorkforceService(aiWorkforceQueueRepo, db);
  const notificationService = new NotificationService(aiWorkforceQueueRepo);

  const copilotChatsRepo = new CopilotChatsRepository(db, workspaceId);
  const copilotChatsService = new CopilotChatsService(copilotChatsRepo);

  const dashboardActivityRepo = new DashboardActivityRepository(db, workspaceId);
  const dashboardActivityService = new DashboardActivityService(dashboardActivityRepo);

  const dashboardInsightsRepo = new DashboardInsightsRepository(db, workspaceId);
  const appSettingsRepo = new AppSettingsRepository(db);
  const dashboardInsightsService = new DashboardInsightsService(
    dashboardInsightsRepo,
    appSettingsRepo,
    thesisRepo,
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
  );

  fileService.setCRMService(crmService);
  fileService.setJobDispatcher(jobDispatcher);

  const chatAttachmentService = new ChatAttachmentService(workspaceId);

  const fundRepo = new FundRepository(db, workspaceId);
  const fundAssetRepo = new FundAssetRepository(db, workspaceId);
  const fundAssetTransactionRepo = new FundAssetTransactionRepository(db, workspaceId);
  const fundAssetValuationRepo = new FundAssetValuationRepository(db, workspaceId);
  const fundMetricsService = new FundMetricsService(
    fundRepo,
    fundAssetRepo,
    fundAssetTransactionRepo,
    fundAssetValuationRepo,
  );
  const fundService = new FundService(fundRepo, fundAssetRepo, fundMetricsService);
  const holdingEntityRepo = new HoldingEntityRepository(db, workspaceId);
  const holdingEntityService = new HoldingEntityService(holdingEntityRepo);
  const fundSourceRepo = new FundSourceRepository(db, workspaceId);
  const fundSourceService = new FundSourceService(fundSourceRepo);
  const fundHoldingEntityStakeRepo = new FundHoldingEntityStakeRepository(db, workspaceId);
  const fundHoldingEntityStakeService = new FundHoldingEntityStakeService(
    fundHoldingEntityStakeRepo,
    fundRepo,
    holdingEntityRepo,
  );
  const fundAssetLedgerService = new FundAssetLedgerService(
    fundAssetTransactionRepo,
    fundAssetValuationRepo,
    fundMetricsService,
  );
  const fundUpdateApplyService = new FundUpdateApplyService(
    fundRepo,
    fundAssetRepo,
    fundAssetTransactionRepo,
    fundAssetValuationRepo,
    holdingEntityRepo,
    fundSourceRepo,
    fundMetricsService,
  );
  fileService.setFundUpdateApplyService(fundUpdateApplyService);
  const fundPortfolioService = new FundPortfolioService(
    fundRepo,
    fundAssetRepo,
    fundAssetTransactionRepo,
    fundAssetValuationRepo,
    workspaceId,
  );
  const fundAiOpinionService = new FundAiOpinionService(
    fundAssetRepo,
    fundAssetValuationRepo,
    db,
    workspaceId,
  );

  const stalledDealService = new StalledDealService(companyRepo, companyLogRepo);

  const dailyPulseRepo = new DailyPulseRepository(db, workspaceId);
  const dailyPulseService = new DailyPulseService(workspaceId, dailyPulseRepo);

  const featureFlagRepo = new FeatureFlagRepository(db);
  const featureFlagsService = new FeatureFlagsService(featureFlagRepo);

  const tableLayoutRepo = new WorkspaceTableLayoutRepository(db, workspaceId);
  const tableLayoutService = new TableLayoutService(tableLayoutRepo);

  const feedbackRepo = new FeedbackRepository(db, workspaceId);
  const feedbackService = new FeedbackService(feedbackRepo, userRepo, workspaceRepo, workspaceId);

  return {
    companyService,
    companyGraphService,
    companyRelationshipService,
    screeningService,
    criteriaService,
    investmentThesisService,
    trackVariableService,
    marketScanningRoutineService,
    dealDocumentService,
    recentFileService,
    dealNoteService,
    dealLinkService,
    companyAnalysisService,
    aiOpinionService,
    aiScreeningService,
    marketScreeningService,
    trackMatchingService,
    slideService,
    companyCardSlideService,
    fileService,
    chatService,
    jobService,
    authService,
    userService,
    crmService,
    aiWorkforceService,
    copilotChatsService,
    dashboardActivityService,
    dashboardInsightsService,
    dailyPulseService,
    apiKeyService,
    apiChatConversationService,
    notificationService,
    workspaceService,
    dealResurfaceService,
    chatAttachmentService,
    fundService,
    holdingEntityService,
    fundSourceService,
    fundHoldingEntityStakeService,
    fundAssetLedgerService,
    fundUpdateApplyService,
    fundPortfolioService,
    fundMetricsService,
    fundAiOpinionService,
    stalledDealService,
    featureFlagsService,
    feedbackService,
    tableLayoutService,
  };
}
