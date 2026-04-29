import type {
  ContactRepository,
  Contact,
  ContactInsert,
  ContactMessageRepository,
  ContactMessage,
  ContactMessageInsert,
} from "@/lib/repositories";

export interface ContactWithMessages extends Contact {
  messages: ContactMessage[];
  message_count: number;
}

export class CRMService {
  constructor(
    private contactRepo: ContactRepository,
    private messageRepo: ContactMessageRepository,
  ) {}

  async findAllContacts(): Promise<Contact[]> {
    return this.contactRepo.findAll();
  }

  async findContactById(id: string): Promise<ContactWithMessages | null> {
    const contact = await this.contactRepo.findById(id);
    if (!contact) return null;
    const messages = await this.messageRepo.findByContactId(id);
    return {
      ...contact,
      messages,
      message_count: messages.length,
    };
  }

  async searchContacts(query: string): Promise<Contact[]> {
    return this.contactRepo.search(query);
  }

  async createContact(data: ContactInsert): Promise<Contact> {
    return this.contactRepo.insert(data);
  }

  async updateContact(
    id: string,
    data: Partial<ContactInsert>,
  ): Promise<Contact | null> {
    const result = await this.contactRepo.update(id, data);
    return result || null;
  }

  async deleteContact(id: string): Promise<void> {
    await this.contactRepo.delete(id);
  }

  async findOrCreateContactByEmail(
    email: string,
    defaultData: Partial<ContactInsert> = {},
  ): Promise<Contact> {
    return this.contactRepo.findOrCreateByEmail(email, defaultData);
  }

  async getMessagesByContactId(contactId: string): Promise<ContactMessage[]> {
    return this.messageRepo.findByContactId(contactId);
  }

  async addMessage(data: ContactMessageInsert): Promise<ContactMessage> {
    return this.messageRepo.insert(data);
  }

  async addMessagesFromFile(
    fileId: string,
    messages: Array<{
      email: string;
      name?: string;
      company?: string;
      direction: "inbound" | "outbound";
      subject?: string;
      body: string;
      sent_at?: string;
      from_email?: string;
      to_email?: string;
    }>,
  ): Promise<{ contacts_created: number; messages_added: number }> {
    let contactsCreated = 0;
    const messagesToInsert: ContactMessageInsert[] = [];

    for (const msg of messages) {
      let contact = await this.contactRepo.findByEmail(msg.email);
      if (!contact) {
        contact = await this.contactRepo.insert({
          email: msg.email,
          name: msg.name || msg.email,
          company: msg.company,
        });
        contactsCreated++;
      }

      messagesToInsert.push({
        contact_id: contact.id,
        file_id: fileId,
        direction: msg.direction,
        subject: msg.subject,
        body: msg.body,
        sent_at: msg.sent_at,
        from_email: msg.from_email,
        to_email: msg.to_email,
      });
    }

    const inserted = await this.messageRepo.insertMany(messagesToInsert);

    return {
      contacts_created: contactsCreated,
      messages_added: inserted.length,
    };
  }

  async deleteMessagesByFileId(fileId: string): Promise<void> {
    await this.messageRepo.deleteByFileId(fileId);
  }
}
