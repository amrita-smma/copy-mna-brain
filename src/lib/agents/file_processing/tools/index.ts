/**
 * Tool registry for the file_processing agent.
 * The agent runs without tools today (the JSON contract is enforced by the
 * system prompt), but the tools are kept here for future use and to satisfy
 * the per-agent folder structure.
 */
import { fuzzySearchCompanyTool } from "./fuzzy_search_company";
import { addCompanyNoteTool } from "./add_company_note";

export { fuzzySearchCompanyTool, addCompanyNoteTool };

export const tools = [fuzzySearchCompanyTool, addCompanyNoteTool];
