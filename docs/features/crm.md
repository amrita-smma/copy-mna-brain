# CRM (Contact Relationship Management)

The CRM module manages contacts and their communication history.

## Database Tables

- **contacts** — Stores contact information (name, email, phone, company, title, type)
- **contact_messages** — Stores communication history linked to contacts

## Features

- Contact management (create, update, delete, search)
- Communication history per contact
- Integration with Smart Files for banker communications

## Banker Communications

Smart Files supports a "banker_communications" file type for CSV and MBOX exports (e.g., from Google Vault). When uploaded:

1. The File Processing Agent detects email communications
2. Contacts are automatically created or matched by email
3. Messages are linked to contacts in the CRM

## API Endpoints

- `GET /api/crm` — List all contacts (supports `?q=` query)
- `POST /api/crm` — Create a new contact
- `GET /api/crm/:id` — Get contact with messages
- `PATCH /api/crm/:id` — Update contact
- `DELETE /api/crm/:id` — Delete contact
- `GET /api/crm/:id/messages` — Get contact's messages
- `POST /api/crm/:id/messages` — Add message to contact
