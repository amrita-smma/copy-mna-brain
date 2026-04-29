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
  ContactRepository,
  ContactMessageRepository,
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
  const jobService = new JobService(jobRepo);
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
  );

  const contactRepo = new ContactRepository(db);
  const contactMessageRepo = new ContactMessageRepository(db);
  const crmService = new CRMService(contactRepo, contactMessageRepo);

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
  };
}
