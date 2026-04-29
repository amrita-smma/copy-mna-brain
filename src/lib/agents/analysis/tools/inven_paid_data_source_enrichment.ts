import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { InvenCacheRepository } from "@/lib/repositories";

/**
 * Inven Paid Data Source Enrichment
 * Gets detailed company data from Inven by company IDs and saves to cache.
 */
export const invenPaidDataSourceEnrichment = tool(
  async ({
    company_ids,
  }: {
    company_ids: string[];
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: inven_paid_data_source_enrichment(company_ids=[${company_ids.join(", ")}])`
    );

    if (!company_ids || company_ids.length === 0) {
      return "**Error:** No company IDs provided. Use inven_paid_data_source_search first to get company IDs.";
    }

    try {
      const invenRepo = new InvenCacheRepository(createDb());
      const apiKey = process.env.INVEN_API_KEY;

      if (!apiKey) {
        logger.warn("INVEN_API_KEY not set");
        return "Inven enrichment is not available. INVEN_API_KEY environment variable is not set.";
      }

      logger.debug(`Calling Inven API for ${company_ids.length} companies...`);

      const identifiers = company_ids.map((id) => ({
        companyId: id,
        domain: null,
      }));

      const response = await fetch("https://api.inven.ai/public-api/v1/company-data-bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          identifiers,
          selections: ["basic"],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Inven API error: ${response.status} - ${errorText}`);
        return `**Inven API Error:** ${response.status} - ${errorText}`;
      }

      const data = await response.json();
      const results = data.results || [];

      if (results.length === 0) {
        return `No data found for the provided company IDs.`;
      }

      const enrichedCompanies: {
        companyId: string;
        companyName: string;
        domain: string;
        website: string;
        description: string;
        country: string;
        headcount: string;
        revenue: string;
        ownership: string;
      }[] = [];

      for (const result of results) {
        const basic = result.basic;
        if (!basic) continue;

        const cacheRecord = {
          inven_company_id: basic.companyId,
          domain: basic.domain,
          inven_company_name: basic.companyName,
          website: basic.website,
          linkedin: basic.linkedin,
          description: basic.description,
          logo_url: basic.logoUrl,
          headcount_min: basic.headcount?.min,
          headcount_max: basic.headcount?.max,
          employee_count: basic.employeeCount,
          revenue_estimate_usd_millions: basic.revenueEstimateUsdMillions,
          ownership: basic.ownership,
          founded_year: basic.foundedYear,
          headquarters_city: basic.headquarters?.city,
          headquarters_state: basic.headquarters?.state,
          headquarters_country_code: basic.headquarters?.countryCode,
          updated_at: new Date().toISOString(),
        };

        try {
          await invenRepo.upsert(cacheRecord);
          logger.debug(`✓ Cached company ${basic.companyId}`);
        } catch (upsertError) {
          logger.error(`Cache upsert error for ${basic.companyId}: ${(upsertError as Error).message}`);
        }

        enrichedCompanies.push({
          companyId: basic.companyId,
          companyName: basic.companyName,
          domain: basic.domain,
          website: basic.website,
          description: basic.description,
          country: basic.headquarters?.countryCode || "N/A",
          headcount: basic.employeeCount ? String(basic.employeeCount) : (basic.headcount ? `${basic.headcount.min}-${basic.headcount.max}` : "N/A"),
          revenue: basic.revenueEstimateUsdMillions ? `$${basic.revenueEstimateUsdMillions}M` : "N/A",
          ownership: basic.ownership || "N/A",
        });
      }

      let result = `**Enriched Company Data (${enrichedCompanies.length} companies):**\n\n`;

      for (const company of enrichedCompanies) {
        result += `### ${company.companyName}\n`;
        result += `- **Inven Company ID:** ${company.companyId}\n`;
        result += `- **Domain:** ${company.domain}\n`;
        result += `- **Website:** ${company.website}\n`;
        result += `- **Country:** ${company.country}\n`;
        result += `- **Headcount:** ${company.headcount}\n`;
        result += `- **Revenue Estimate:** ${company.revenue}\n`;
        result += `- **Ownership:** ${company.ownership}\n`;
        result += `- **Description:** ${company.description || "N/A"}\n\n`;
      }

      result += `*Data has been cached for future queries.*`;

      logger.debug(`✓ Enriched and cached ${enrichedCompanies.length} companies`);
      return result;
    } catch (error) {
      logger.error(`Inven enrichment error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "inven_paid_data_source_enrichment",
    description: `Get detailed company data from Inven by company IDs.

Use this tool ONLY when you have Inven Company IDs (from inven_paid_data_source_search).
The tool fetches detailed company data and saves it to the local cache for future use.

Args:
    company_ids: Array of Inven Company IDs to enrich (e.g., ["3588005", "179942"])

Returns:
    Detailed company profiles including description, headcount, revenue estimates, ownership, and headquarters.`,
    schema: z.object({
      company_ids: z.array(z.string()).describe("Array of Inven Company IDs to enrich"),
    }),
  }
);
