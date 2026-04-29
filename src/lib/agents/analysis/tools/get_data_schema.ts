import { tool } from "@langchain/core/tools";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyRepository } from "@/lib/repositories";
import {
  companiesSchema,
  companyFinancialsSchema,
  companyFxAdjustmentsSchema,
} from "./schemas";

/**
 * Get the schema of the companies data including column names and types.
 */
export const getDataSchema = tool(
  async () => {
    logger.debug("🔧 TOOL CALLED: get_data_schema()");

    let rowCount = 0;
    try {
      const companyRepo = new CompanyRepository(createDb());
      rowCount = await companyRepo.countAll();
    } catch (error) {
      logger.error(`Error getting row count: ${(error as Error).message}`);
    }

    const columnsInfo = companiesSchema.map((col) => `  - ${col.name} (${col.type})`);
    const financialsInfo = companyFinancialsSchema.map((col) => `  - ${col.name} (${col.type})`);
    const fxInfo = companyFxAdjustmentsSchema.map((col) => `  - ${col.name} (${col.type})`);

    const result = `## Companies Data Schema

**Table:** companies
**Total Rows:** ${rowCount}
**Key Columns (${companiesSchema.length} total):**

${columnsInfo.join("\n")}

**Table:** company_financials (one row per company per fiscal_year; join on company_financials.company_id = companies.id)
**Key Columns:**

${financialsInfo.join("\n")}

**Table:** company_fx_adjustments (one row per company per fiscal_year for non-USD companies; join on company_fx_adjustments.company_id = companies.id)
**Key Columns:**

${fxInfo.join("\n")}

Use the query_companies tool to search and filter company data.
Use the get_company_details tool to retrieve a company's full financial history across all fiscal years.
Use the get_company_stats tool for aggregate statistics.
`;

    logger.debug(`✓ Schema retrieved: ${companiesSchema.length} columns, ${rowCount} rows`);
    return result;
  },
  {
    name: "get_data_schema",
    description: `Get the schema of the companies data including column names and types.
Use this to understand what data is available before writing queries.

Returns:
    A description of the table schema with column names and types.`,
  }
);
