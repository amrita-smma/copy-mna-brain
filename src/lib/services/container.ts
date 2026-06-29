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
  UserCompanyFavoriteRepository,
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
  ApiKeyRepository,
  ApiChatConversationRepository,
  RoutinesRepository,
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
import { AIScreeningService } from './aiScreeningService';
import { MarketScreeningService } from './marketScreeningService';
import { TrackMatchingService } from './trackMatchingService';
import { SlideService } from './slideService';
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
import { ApiKeyService } from './apiKeyService';
import { ApiChatConversationService } from './apiChatConversationService';
import { NotificationService } from './notificationService';

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
  apiKeyService: ApiKeyService;
  apiChatConversationService: ApiChatConversationService;
  notificationService: NotificationService;
}

export function createContainer(db: DbClient): Container {
  const jobDispatcher = new JobDispatcher(db, createDb);

  // Neo4j mirror: the relationship-graph repo doubles as the write-through
  // mirror for company writes. The driver is a cached global singleton and is
  // only touched when a company is actually written, so wiring it in adds no
  // cost to graph-less requests. Postgres stays the source of truth — Neo4j
  // follows every insert/update/delete that flows through CompanyRepository.
  const companyGraphRepo = new CompanyRelationRepository(createNeo4jDriver());

  const companyRepo = new CompanyRepository(db, companyGraphRepo);
  const companyLogRepo = new CompanyLogRepository(db);
  const screeningRepo = new ScreeningRepository(db);
  const criteriaRepo = new CriteriaRepository(db);
  const dealDocRepo = new DealDocumentRepository(db);
  const dealNoteRepo = new DealNoteRepository(db);
  const dealLinkRepo = new DealLinkRepository(db);
  const companyAnalysisRepo = new CompanyAnalysisRepository(db);
  const companySlidesRepo = new CompanySlidesRepository(db);
  const fileRepo = new FileRepository(db);
  const thesisRepo = new InvestmentThesisRepository(db);
  const trackVariableRepo = new TrackVariableRepository(db);
  const jobRepo = new JobRepository(db);
  const userRepo = new UserRepository(db);
  const resetTokenRepo = new ResetPasswordTokenRepository(db);
  const userFavoriteRepo = new UserCompanyFavoriteRepository(db);
  const recentFileRepo = new RecentFileRepository(db);
  const companyFinancialRepo = new CompanyFinancialRepository(db);
  const companyFxAdjustmentRepo = new CompanyFxAdjustmentRepository(db);
  const companyScreeningDerivedRepo = new CompanyScreeningDerivedRepository(db);

  const criteriaService = new CriteriaService(criteriaRepo);
  const screeningService = new ScreeningService(screeningRepo);
  const routinesRepo = new RoutinesRepository(db);
  const marketScanningRoutineService = new MarketScanningRoutineService(routinesRepo);
  const investmentThesisService = new InvestmentThesisService(
    thesisRepo,
    marketScanningRoutineService,
  );
  const trackVariableService = new TrackVariableService(trackVariableRepo);
  const dealNoteService = new DealNoteService(dealNoteRepo);
  const dealLinkService = new DealLinkService(dealLinkRepo);
  const jobService = new JobService(jobRepo, screeningRepo);
  const authService = new AuthService(userRepo, resetTokenRepo);
  const userService = new UserService(userRepo, userFavoriteRepo);
  const chatService = new ChatService(thesisRepo, criteriaRepo);

  const companyAnalysisService = new CompanyAnalysisService(companyAnalysisRepo, companyRepo, db);
  const aiOpinionService = new AiOpinionService(companyRepo, db);
  const aiScreeningService = new AIScreeningService(screeningRepo, jobDispatcher);
  const marketScreeningService = new MarketScreeningService(jobDispatcher);
  const trackMatchingService = new TrackMatchingService(jobDispatcher, db);
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
    fileRepo,
    companyAnalysisService,
    aiScreeningService,
    criteriaRepo,
    screeningRepo,
    companyFinancialRepo,
    companyService,
    companyFxAdjustmentRepo,
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
  );

  const aiWorkforceQueueRepo = new AiWorkforceQueueRepository(db);
  const aiWorkforceService = new AiWorkforceService(aiWorkforceQueueRepo, db);
  const notificationService = new NotificationService(aiWorkforceQueueRepo);

  const copilotChatsRepo = new CopilotChatsRepository(db);
  const copilotChatsService = new CopilotChatsService(copilotChatsRepo);

  const dashboardActivityRepo = new DashboardActivityRepository(db);
  const dashboardActivityService = new DashboardActivityService(dashboardActivityRepo);

  const dashboardInsightsRepo = new DashboardInsightsRepository(db);
  const appSettingsRepo = new AppSettingsRepository(db);
  const dashboardInsightsService = new DashboardInsightsService(
    dashboardInsightsRepo,
    appSettingsRepo,
  );

  const apiKeyRepo = new ApiKeyRepository(db);
  const apiKeyService = new ApiKeyService(apiKeyRepo);

  const apiChatConversationRepo = new ApiChatConversationRepository(db);
  const apiChatConversationService = new ApiChatConversationService(apiChatConversationRepo);

  fileService.setCRMService(crmService);

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
    apiKeyService,
    apiChatConversationService,
    notificationService,
  };
}
