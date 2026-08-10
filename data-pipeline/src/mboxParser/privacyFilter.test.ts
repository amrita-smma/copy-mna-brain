import { describe, expect, it } from 'vitest';
import { parseHeaders } from './parser';
import {
  isDomainBlacklisted,
  isSensitiveAttachmentFilename,
  isSensitiveContent,
  isOfficeAttachment,
  runPrivacyFilter,
  shouldBypassPdfTriage,
  shouldBypassOfficeTriage,
  clipOfficeTriageText,
  hasEnoughOfficeExtractText,
  PDF_TRIAGE_SOFT_MAX_BYTES,
  OFFICE_TRIAGE_MAX_CHARS,
  OFFICE_TRIAGE_MIN_CHARS,
} from './privacyFilter';

describe('privacyFilter', () => {
  it('does not hard-drop personal providers (align with crmIngest)', () => {
    const headers = parseHeaders(
      'From: alice@gmail.com\nTo: banker@starcapital.co.id\nSubject: LOI Draft for Project Alpha\n\n',
    );
    expect(isDomainBlacklisted(headers)).toBe(false);
    expect(runPrivacyFilter(headers, 'Please find the LOI attached.').skip).toBe(
      false,
    );
  });

  it('hard-drops curated excluded domains at step 1', () => {
    const headers = parseHeaders('From: spam@blocked.example\nSubject: Hello\n\n');
    const excluded = new Set(['blocked.example']);
    expect(isDomainBlacklisted(headers, excluded)).toBe(true);
    const r = runPrivacyFilter(headers, '', { excludedDomains: excluded });
    expect(r).toMatchObject({ skip: true, reason: 'domain_blacklist', step: 1 });
  });

  it('flags sensitive salary-review subjects at step 2', () => {
    const headers = parseHeaders('From: banker@goldman.com\nSubject: Salary Review Q3\n\n');
    expect(isSensitiveContent(headers)).toBe(true);
    expect(runPrivacyFilter(headers, '').reason).toBe('sensitive_content');
  });

  it('does not drop deal subjects that merely mention salary', () => {
    const headers = parseHeaders(
      'From: banker@goldman.com\nTo: a@b.com\nSubject: LOI — salary expectations for Project Alpha\n\n',
    );
    expect(isSensitiveContent(headers)).toBe(false);
    expect(runPrivacyFilter(headers, 'Please find the LOI attached.').skip).toBe(
      false,
    );
  });

  it('does not drop the whole email for sensitive attachment names (step 3)', () => {
    expect(isSensitiveAttachmentFilename('payslip_october_2025.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('July_2026_payslip.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('deal_compensation_model.xlsx')).toBe(
      false,
    );
    const headers = parseHeaders(
      'From: banker@goldman.com\nTo: a@b.com\nSubject: LOI Draft for Project Alpha\n\n',
    );
    const r = runPrivacyFilter(headers, 'Please find the LOI attached.', {
      attachmentFilenames: ['payslip_october_2025.pdf'],
    });
    // Envelope still passes; emailProcess Smart Files path calls
    // isSensitiveAttachmentFilename per-file before upload.
    expect(r.skip).toBe(false);
  });

  it('blocks HR/CV filenames aligned with subject gate', () => {
    expect(isSensitiveAttachmentFilename('Candidate_CV.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('john_resume.docx')).toBe(true);
    expect(isSensitiveAttachmentFilename('cover_letter.docx')).toBe(true);
    expect(isSensitiveAttachmentFilename('candidate_cover_letter.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('HR_Confidential_memo.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('benefits_enrollment.xlsx')).toBe(true);
    expect(isSensitiveAttachmentFilename('Project_Alpha_IM.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('Project_Nova_LBO_Model.xlsx')).toBe(
      false,
    );
    // Must not match "resume" as a substring of unrelated tokens.
    expect(isSensitiveAttachmentFilename('presumed_synergies.docx')).toBe(false);
  });

  // Email attachments very often use spaces rather than _ or - separators.
  it('blocks space- and dot-separated HR filenames', () => {
    expect(isSensitiveAttachmentFilename('Cover Letter.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Pay Slip October.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Salary Review 2026.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Performance Review Q3.docx')).toBe(true);
    expect(isSensitiveAttachmentFilename('HR Confidential.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Employee Contract.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Benefits Enrollment.xlsx')).toBe(true);
    expect(isSensitiveAttachmentFilename('Candidate Resume.docx')).toBe(true);
    expect(isSensitiveAttachmentFilename('pay.slip.pdf')).toBe(true);
    // Still matches the original underscore/no-separator spellings.
    expect(isSensitiveAttachmentFilename('payslip.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('pay_slip.pdf')).toBe(true);
    // Deal docs with unrelated words must still pass.
    expect(isSensitiveAttachmentFilename('Project Alpha Teaser.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('Q3 Financial Model.xlsx')).toBe(false);
  });

  it('blocks non-deal admin/personal filenames (MB-465)', () => {
    expect(isSensitiveAttachmentFilename('vendor_invoice_march.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Invoice_Q1.xlsx')).toBe(true);
    expect(isSensitiveAttachmentFilename('offer_letter.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Offer Letter.docx')).toBe(true);
    expect(isSensitiveAttachmentFilename('offer-letter.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('offer__letter.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('passport_scan.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('tax_return_2025.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Tax Return.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('form_w2.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('form__w-2.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('W-2_2025.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('w2.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('bank_statement_jan.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('Bank Statement.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('bank__statement.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('expense_receipt.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('hotel_receipt.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('uber_receipt.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('store_receipt.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('tax_receipt.pdf')).toBe(true);

    // Must NOT false-positive on closing / deal / DD docs.
    expect(isSensitiveAttachmentFilename('wire_transfer_receipt.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('escrow_receipt.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('Project_SOW_v2.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('statement_of_work.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('tax_structuring_memo.pdf')).toBe(false);
    expect(isSensitiveAttachmentFilename('financial_statement_FY24.pdf')).toBe(
      false,
    );
    expect(isSensitiveAttachmentFilename('Project_Alpha_IM.pdf')).toBe(false);
  });

  it('blocks performance-improvement and curriculum-vitae filenames', () => {
    expect(isSensitiveAttachmentFilename('Performance Improvement Plan.pdf')).toBe(
      true,
    );
    expect(isSensitiveAttachmentFilename('performance_improvement.docx')).toBe(
      true,
    );
    expect(isSensitiveAttachmentFilename('Curriculum Vitae.pdf')).toBe(true);
    expect(isSensitiveAttachmentFilename('curriculum_vitae.docx')).toBe(true);
  });

  it('falls through to shouldSkip for newsletters', () => {
    const headers = parseHeaders(
      'From: news@corp.com\nList-Unsubscribe: <mailto:x>\nSubject: Weekly\n\n',
    );
    const r = runPrivacyFilter(headers, '');
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('newsletter');
    expect(r.step).toBe(4);
  });

  it('allows deal mail through', () => {
    const headers = parseHeaders(
      'From: banker@goldmansachs.com\nTo: alice@external.com\nSubject: LOI Draft for Project Alpha\n\n',
    );
    expect(runPrivacyFilter(headers, 'Please find the LOI attached.').skip).toBe(false);
  });

  it('flags PDFs above the soft cap as too large to triage (skip Smart Files)', () => {
    expect(shouldBypassPdfTriage(PDF_TRIAGE_SOFT_MAX_BYTES + 1)).toBe(true);
    expect(shouldBypassPdfTriage(PDF_TRIAGE_SOFT_MAX_BYTES)).toBe(false);
    expect(shouldBypassPdfTriage(1000)).toBe(false);
  });

  it('recognises Office attachments by MIME or extension', () => {
    const docxMime =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(isOfficeAttachment(docxMime, 'no-extension')).toBe(true);
    // Generic MIME is common in MBOX parts — must fall back to extension.
    expect(isOfficeAttachment('application/octet-stream', 'deal.docx')).toBe(true);
    expect(isOfficeAttachment('application/octet-stream', 'model.XLSX')).toBe(true);
    expect(isOfficeAttachment('', 'teaser.pptx')).toBe(true);
    expect(isOfficeAttachment('application/octet-stream', 'notes.txt')).toBe(false);
    expect(isOfficeAttachment('image/png', 'logo.png')).toBe(false);
    expect(isOfficeAttachment('application/octet-stream', null)).toBe(false);
    // Must not match an extension appearing mid-name.
    expect(isOfficeAttachment('application/octet-stream', 'a.docx.exe')).toBe(false);
  });

  it('applies the same soft byte cap to Office attachments', () => {
    expect(shouldBypassOfficeTriage(PDF_TRIAGE_SOFT_MAX_BYTES + 1)).toBe(true);
    expect(shouldBypassOfficeTriage(PDF_TRIAGE_SOFT_MAX_BYTES)).toBe(false);
  });

  it('clips Office extract text to the triage window', () => {
    const huge = 'a'.repeat(OFFICE_TRIAGE_MAX_CHARS + 500);
    const clipped = clipOfficeTriageText(huge);
    expect(clipped.length).toBe(OFFICE_TRIAGE_MAX_CHARS);
    expect(clipOfficeTriageText('short').length).toBe(5);
  });

  it('rejects near-empty Office extracts', () => {
    expect(hasEnoughOfficeExtractText('')).toBe(false);
    expect(hasEnoughOfficeExtractText('   \n\t  ')).toBe(false);
    expect(hasEnoughOfficeExtractText('x'.repeat(OFFICE_TRIAGE_MIN_CHARS - 1))).toBe(
      false,
    );
    expect(hasEnoughOfficeExtractText('x'.repeat(OFFICE_TRIAGE_MIN_CHARS))).toBe(
      true,
    );
  });
});
