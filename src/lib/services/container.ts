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
  JobRepository,
  ResetPasswordTokenRepository,
  UserRepository,
  UserCompanyFavoriteRepository,
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
  ApiKeyRepository,
  ApiChatConversationRepository,
} from '@/lib/repositories';
import { JobDispatcher } from './jobDispatcher';
import { CompanyService } from './companyService';
import { ScreeningService } from './screeningService';
import { CriteriaService } from './criteriaService';
import { InvestmentThesisService } from './investmentThesisService';
import { DealDocumentService } from './dealDocumentService';
import { DealNoteService } from './dealNoteService';
import { DealLinkService } from './dealLinkService';
import { CompanyAnalysisService } from './companyAnalysisService';
import { AIScreeningService } from './aiScreeningService';
import { MarketScreeningService } from './marketScreeningService';
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
import { ApiKeyService } from './apiKeyService';
import { ApiChatConversationService } from './apiChatConversationService';
import { NotificationService } from './notificationService';

export interface Container {
  companyService: CompanyService;
  screeningService: ScreeningService;
  criteriaService: CriteriaService;
  investmentThesisService: InvestmentThesisService;
  dealDocumentService: DealDocumentService;
  dealNoteService: DealNoteService;
  dealLinkService: DealLinkService;
  companyAnalysisService: CompanyAnalysisService;
  aiScreeningService: AIScreeningService;
  marketScreeningService: MarketScreeningService;
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
  apiKeyService: ApiKeyService;
  apiChatConversationService: ApiChatConversationService;
  notificationService: NotificationService;
}

export function createContainer(db: DbClient): Container {
  const jobDispatcher = new JobDispatcher(db, createDb);

  const companyRepo = new CompanyRepository(db);
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
  const jobRepo = new JobRepository(db);
  const userRepo = new UserRepository(db);
  const resetTokenRepo = new ResetPasswordTokenRepository(db);
  const userFavoriteRepo = new UserCompanyFavoriteRepository(db);
  const companyFinancialRepo = new CompanyFinancialRepository(db);
  const companyFxAdjustmentRepo = new CompanyFxAdjustmentRepository(db);
  const companyScreeningDerivedRepo = new CompanyScreeningDerivedRepository(db);

  const criteriaService = new CriteriaService(criteriaRepo);
  const screeningService = new ScreeningService(screeningRepo);
  const investmentThesisService = new InvestmentThesisService(thesisRepo);
  const dealNoteService = new DealNoteService(dealNoteRepo);
  const dealLinkService = new DealLinkService(dealLinkRepo);
  const jobService = new JobService(jobRepo, screeningRepo);
  const authService = new AuthService(userRepo, resetTokenRepo);
  const userService = new UserService(userRepo, userFavoriteRepo);
  const chatService = new ChatService(thesisRepo, criteriaRepo);

  const companyAnalysisService = new CompanyAnalysisService(companyAnalysisRepo, jobDispatcher);
  const aiScreeningService = new AIScreeningService(screeningRepo, jobDispatcher);
  const marketScreeningService = new MarketScreeningService(jobDispatcher);
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
  );
  const dealDocumentService = new DealDocumentService(dealDocRepo);
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

  const apiKeyRepo = new ApiKeyRepository(db);
  const apiKeyService = new ApiKeyService(apiKeyRepo);

  const apiChatConversationRepo = new ApiChatConversationRepository(db);
  const apiChatConversationService = new ApiChatConversationService(apiChatConversationRepo);

  fileService.setCRMService(crmService);

  return {
    companyService,
    screeningService,
    criteriaService,
    investmentThesisService,
    dealDocumentService,
    dealNoteService,
    dealLinkService,
    companyAnalysisService,
    aiScreeningService,
    marketScreeningService,
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
    apiKeyService,
    apiChatConversationService,
    notificationService,
  };
}
