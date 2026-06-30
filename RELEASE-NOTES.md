June 30, 2026 Release Notes
Covers everything merged since Tuesday Jun 23, 8:00 AM.

✨ Features
- Introduced Tracks: multi-track support, a one-pager company overview, AI-screening criteria attached to each track, and track-specific fields (#263, #274, #296)
- Added AI Opinion on companies, configurable track variables, and a Dive Deeper action (#297, #298, f3b7fed)
- Added a CRM-to-Chatbot integration so CRM data is queryable through the assistant (#259)
- Added a Presentation previewer that displays slide decks inline with maximize and file-cache support (#258)
- Added an "Awaiting Review" stage for the AI File Dump intake flow (#255)
- Added Entered By and Deal Captain / Deal Sponsor roles across forms and tables (#268)
- Enforced mandatory L0 fields before a company can enter the committed pipeline, with inline validation errors (#281)
- Separated inbound "Pending Review" companies onto their own tab (#269)
- Added the ability to send emails from the app (4de44eb)
- Added Deal Sponsor to the dashboard and made the Sponsor/Captain header filterable (#282, 5e2c68a)
- Added the ability to cancel company-card generation mid-run (#271)
- Allowed editing matched tracks directly from company details (#284)
- Added a Company Overview (L4) slide with EBITDA margin (a09bc0e, 9d2cf2d)

🚀 Enhancements
- Made the dashboard activity feed clickable and added remarks to feed entries, with entered_by attribution surfaced throughout (#266, #265, #294)
- Made the "Dropped On" column sortable and improved the active-vs-dropped toggle (#290, 3356e92)
- Removed the redundant PIC and Originator columns from the pipeline tables and widened the layout (#291, 249f4f8)
- Polished the drop-reason column to show full wrapped text instead of a truncated pill (#294)
- Strengthened AI powers and made company-card generation more succinct (e1418a2, 3c472c6)
- Various UI refinements: sticky company header, presentation mode extraction, simplified filters, transparent settings button, and more (#270)
- Reformatted company / project naming and carried project names through L0→L1 submission (a03d66c, 9316b5e)
- Made Entered By editable and Deal Sponsor read-only in the table (2925a08, 02d6e98)
- Updated email signature and removed stale recipients (35ea6e4, ee22634, dada98e)

🐛 Bugfixes
- Fixed a pipeline stage/source count mismatch and surfaced pre-L0 companies in the feed (#288)
- Corrected entered_by attribution, removed a duplicate column, and fixed the Deal Sponsor/Captain split for pre-pipeline stages (#285)
- Fixed the attachment pipeline to handle empty company/project names and to skip company creation for financial-statement-only files (#262, #253)
- Stopped the AI Workforce add_company from writing directly to L0 (#256)
- Fixed PIC not showing in Master Data (#257)
- Fixed the search bar and removed the stray "create user" action (#292)
- Fixed the Add button and track-matching behavior, including no track-matching on demotion (#286)
- Fixed a broken build and a migration error (#293, #287)
- Fixed the entered_by editor and a stray yellow highlight (#289, 027eed6)
- 