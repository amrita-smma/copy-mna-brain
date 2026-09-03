import { and, eq, inArray } from 'drizzle-orm';
import { companies, dealDocuments } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class DealDocumentRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findById(id: string): Promise<Tables<'deal_documents'>> {
    const [row] = await this.db
      .select()
      .from(dealDocuments)
      .where(and(eq(dealDocuments.id, id), inArray(dealDocuments.deal_id, this.workspaceCompanyIds())))
      .limit(1);
    if (!row) throw new Error(`Deal document ${id} not found`);
    return row;
  }

  async findPathAndNameById(
    id: string,
  ): Promise<Pick<Tables<'deal_documents'>, 'file_path' | 'file_name'>> {
    const [row] = await this.db
      .select({ file_path: dealDocuments.file_path, file_name: dealDocuments.file_name })
      .from(dealDocuments)
      .where(and(eq(dealDocuments.id, id), inArray(dealDocuments.deal_id, this.workspaceCompanyIds())))
      .limit(1);
    if (!row) throw new Error(`Deal document ${id} not found`);
    return row;
  }

  async findFilePathsByDealId(dealId: string): Promise<string[]> {
    const rows = await this.db
      .select({ file_path: dealDocuments.file_path })
      .from(dealDocuments)
      .where(and(eq(dealDocuments.deal_id, dealId), inArray(dealDocuments.deal_id, this.workspaceCompanyIds())));
    return rows.map((d) => d.file_path).filter(Boolean);
  }

  async insert(data: TablesInsert<'deal_documents'>): Promise<Tables<'deal_documents'>> {
    const [row] = await this.db.insert(dealDocuments).values(data).returning();
    if (!row) throw new Error('Failed to insert deal document');
    return row;
  }

  async updatePartial(id: string, updates: TablesUpdate<'deal_documents'>): Promise<void> {
    await this.db
      .update(dealDocuments)
      .set(updates)
      .where(and(eq(dealDocuments.id, id), inArray(dealDocuments.deal_id, this.workspaceCompanyIds())));
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(dealDocuments)
      .where(and(eq(dealDocuments.id, id), inArray(dealDocuments.deal_id, this.workspaceCompanyIds())));
  }
}
