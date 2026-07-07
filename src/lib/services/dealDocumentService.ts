import { deleteFile } from '@/lib/s3';
import type { DealDocumentRepository, TablesInsert } from '@/lib/repositories';

export class DealDocumentService {
  constructor(private readonly dealDocRepo: DealDocumentRepository) {}

  register(data: Omit<TablesInsert<'deal_documents'>, 'workspace_id'>) {
    return this.dealDocRepo.insert(data);
  }

  async delete(id: string) {
    const row = await this.dealDocRepo.findById(id);
    await deleteFile(row.file_path);
    await this.dealDocRepo.delete(id);
  }
}
