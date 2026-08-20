import { extractPptxText } from "./pptxExtractor";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

/**
 * Extracts raw text from various file formats.
 * @param buffer - The file buffer
 * @param mimeType - The MIME type of the file
 * @param fileName - The original file name
 * @returns The extracted text content
 */
export async function extractTextFromFile(
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<string> {
  const lowerName = fileName.toLowerCase();

  // 1. PDF
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    try {
      const data = await pdf(buffer);
      return data.text;
    } catch (e) {
      console.error("Error extracting text from PDF:", e);
      throw new Error(`Failed to extract text from PDF: ${(e as Error).message}`);
    }
  }

  // 2. DOCX
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (e) {
      console.error("Error extracting text from DOCX:", e);
      throw new Error(`Failed to extract text from DOCX: ${(e as Error).message}`);
    }
  }

  // 3. PPTX
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    lowerName.endsWith(".pptx")
  ) {
    return extractPptxText(buffer);
  }

  // 4. XLSX & XLSM
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    mimeType === "application/vnd.ms-excel" ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".xlsm")
  ) {
    try {
      const { serializeWorkbookFromBuffer, formatWorkbookAsText } = await import("./workbook/serializeWorkbook");
      const serialized = await serializeWorkbookFromBuffer(buffer, fileName);
      return formatWorkbookAsText(serialized);
    } catch (e) {
      console.error("Error extracting text from Excel workbook:", e);
      throw new Error(`Failed to extract text from Excel workbook: ${(e as Error).message}`);
    }
  }

  // 5. CSV
  if (
    mimeType === "text/csv" ||
    lowerName.endsWith(".csv")
  ) {
    // For CSV, we can just treat it as text since the requirement is "extraction"
    return buffer.toString("utf-8");
  }

  // 6. JSON
  if (mimeType === "application/json" || lowerName.endsWith(".json")) {
    try {
      const str = buffer.toString("utf-8");
      // Validate JSON
      JSON.parse(str);
      return str;
    } catch (e) {
      // treating as text
      return buffer.toString("utf-8");
    }
  }

  // 7. Plain Text / Fallback
  // If it's text/* or we just want to try reading as text
  return buffer.toString("utf-8");
}
