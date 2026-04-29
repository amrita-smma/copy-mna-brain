-- Create contacts table for CRM
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  type TEXT DEFAULT 'external', -- 'internal' for StarCapital employees, 'external' for others
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for contacts
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);

-- Create contact_messages table for communication history
CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'inbound', -- 'inbound' or 'outbound'
  subject TEXT,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  from_email TEXT,
  to_email TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for contact_messages
CREATE INDEX IF NOT EXISTS idx_contact_messages_contact_id ON contact_messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_messages_file_id ON contact_messages(file_id);
CREATE INDEX IF NOT EXISTS idx_contact_messages_sent_at ON contact_messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_contact_messages_direction ON contact_messages(direction);

-- RLS policies for contacts
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read access on contacts" ON contacts FOR SELECT TO public USING (true);
CREATE POLICY "Allow insert access on contacts" ON contacts FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow update access on contacts" ON contacts FOR UPDATE TO public USING (true);
CREATE POLICY "Allow delete access on contacts" ON contacts FOR DELETE TO public USING (true);

-- RLS policies for contact_messages
ALTER TABLE contact_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read access on contact_messages" ON contact_messages FOR SELECT TO public USING (true);
CREATE POLICY "Allow insert access on contact_messages" ON contact_messages FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow update access on contact_messages" ON contact_messages FOR UPDATE TO public USING (true);
CREATE POLICY "Allow delete access on contact_messages" ON contact_messages FOR DELETE TO public USING (true);
