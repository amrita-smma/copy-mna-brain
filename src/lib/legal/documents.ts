import { GMAIL_COMPOSE_SCOPE, GMAIL_SCOPE } from '@/lib/gmail/config';
import type { LegalConfig } from './config';

/**
 * The text of the public Privacy Policy and Terms of Service, as data so one
 * component renders both and the claims can be unit-tested. Claims about the
 * Gmail integration are derived from, and must stay true to, the code in
 * `src/lib/gmail` and `docs/features/gmail.md`: when that behaviour changes,
 * change this text and bump `LEGAL_EFFECTIVE_DATE`.
 *
 * This is a plain-language working draft. It has not been reviewed by a lawyer.
 */

export interface LegalLink {
  label: string;
  href: string;
}

export interface LegalSection {
  id: string;
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  links?: LegalLink[];
}

export interface LegalDocument {
  title: string;
  effectiveDate: string;
  intro: string[];
  sections: LegalSection[];
}

export const GOOGLE_API_USER_DATA_POLICY_URL = 'https://developers.google.com/terms/api-services-user-data-policy';
export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/**
 * Google's required Limited Use statement, which the Privacy Policy of any app
 * using restricted Gmail scopes must contain. Kept as one exported string so
 * a test can pin it and an edit cannot quietly drop it.
 */
export function limitedUseStatement(config: LegalConfig): string {
  return `${config.productName}'s use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.`;
}

function contactParagraph(config: LegalConfig): string {
  return config.contactEmail
    ? `Questions, requests to access or delete data, or concerns about this document: ${config.contactEmail}.`
    : `Questions, requests to access or delete data, or concerns about this document: please contact your workspace administrator or ${config.entityName}'s IT / Compliance team.`;
}

export function privacyPolicy(config: LegalConfig): LegalDocument {
  const { productName, entityName } = config;
  return {
    title: 'Privacy Policy',
    effectiveDate: config.effectiveDate,
    intro: [
      `${productName} is a deal-tracking, origination and research platform operated by ${entityName} ("we", "us"). This policy explains what information the service handles, why, who it is shared with, and the choices you have. It applies to ${productName} and to the optional apps you can connect to it, including Gmail.`,
    ],
    sections: [
      {
        id: 'information',
        title: '1. Information we handle',
        bullets: [
          'Account information: your name, email address and sign-in details (a password hash, or your Google account identifier if you sign in with Google), and the workspaces you belong to.',
          'Workspace content: the companies, notes, documents, files, contacts and other records you or your colleagues add or that the service generates for your workspace.',
          'Conversations: the messages you exchange with the Copilot and its bots, the files you attach, the answers produced, and the tool results the bots read while answering.',
          'Usage and diagnostic data: pages and features used, errors and performance traces, so we can operate and improve the service.',
          'Connected-app data: only what you explicitly connect, described below for Gmail.',
        ],
      },
      {
        id: 'google-data',
        title: '2. Google user data and Gmail',
        paragraphs: [
          'Gmail is optional and off until you connect it yourself from Profile → Connected apps. You sign in with Google and approve exactly what is shown on Google’s consent screen.',
        ],
        bullets: [
          `What we ask for: ${GMAIL_SCOPE} (search and read your mail) and ${GMAIL_COMPOSE_SCOPE} (save drafts in your Drafts folder). You may untick the draft permission on Google’s consent screen; reading still works and the app offers to reconnect later.`,
          'What we do with it: when you ask a bot a question that needs your email, it searches and reads the messages relevant to that question — sender, recipients, subject, date, snippet, body text and attachment names — only while answering you. It never reads attachment contents.',
          'Drafts: when you ask a bot to write an email, it saves the email as a draft in your own Gmail Drafts folder, for you to review, edit and send yourself. Our software never sends email from your Gmail account, and never changes, labels, archives or deletes your existing mail.',
          'What we store: your Google account email address and the OAuth tokens needed to act as you, encrypted at rest. We do not keep a separate copy or index of your mailbox.',
          'Where mail text goes: text a bot reads becomes part of that conversation. It is stored with the conversation history like anything else in the chat, and it is sent to the AI model provider used to write the answer. If the Copilot memory feature is on for you, facts from a conversation may be remembered; you can view and delete them in your profile.',
          'Who can see it: only you, within your own chats. Another member can never read your mailbox through us; each request is made with your own connection.',
          'What we never do: sell Google user data, use it for advertising or credit decisions, transfer it to data brokers, or use it to develop, improve or train generalized AI or machine-learning models. Humans at our organization do not read your Gmail content except with your explicit consent, where needed for security or to comply with law, or where it is aggregated and anonymized for internal operations.',
        ],
      },
      {
        id: 'limited-use',
        title: '3. Google API Services User Data Policy — Limited Use',
        paragraphs: [
          limitedUseStatement(config),
          'Concretely: we use Gmail data only to provide the user-facing features you invoke (answering questions about your mail and saving drafts you asked for); we transfer it only to provide those features, to comply with law, or as part of a merger or sale with notice to you; and we do not use or transfer it for any other purpose.',
        ],
        links: [{ label: 'Google API Services User Data Policy', href: GOOGLE_API_USER_DATA_POLICY_URL }],
      },
      {
        id: 'use',
        title: '4. How we use information',
        bullets: [
          'To provide, secure and support the service and the features you use.',
          'To generate answers, research, drafts and analysis you ask for.',
          'To keep the service reliable: monitoring, debugging, abuse prevention and capacity planning.',
          'To meet legal and compliance obligations and to enforce the Terms of Service.',
        ],
      },
      {
        id: 'providers',
        title: '5. AI models and service providers',
        paragraphs: [
          'We use third parties to run the service. They process information only on our instructions and only to provide their service to us. They fall into these groups:',
        ],
        bullets: [
          'AI model providers (for example Anthropic, including through Amazon Bedrock) that generate the Copilot’s answers from the text we send them.',
          'Cloud infrastructure and hosting (for example Amazon Web Services and Vercel) for compute, databases, file storage and email delivery.',
          'Observability and product analytics tools for error and performance traces and usage statistics.',
          'Sign-in providers, such as Google, when you choose to sign in with them.',
        ],
      },
      {
        id: 'sharing',
        title: '6. Sharing',
        paragraphs: [
          `We do not sell personal information. We share it with the providers above to run the service, with other members of your own workspace according to its permissions, with ${entityName} personnel who administer the service, and with authorities where the law requires. If the business is reorganized or transferred, information may move with it, subject to this policy.`,
        ],
      },
      {
        id: 'retention',
        title: '7. Retention and deletion',
        bullets: [
          'Gmail connection: kept until you press Disconnect in Profile → Connected apps, which revokes our access with Google and deletes the stored tokens immediately. We also delete it automatically if Google tells us the access was revoked or has expired.',
          'You can withdraw access at any time from your Google Account as well: Security → Third-party access.',
          'Conversations and workspace content: kept while your workspace uses them, and deleted when you or your workspace administrator remove them, when the workspace or your account is removed, or on request.',
          'Backups and logs age out on their normal schedules after deletion.',
        ],
        links: [{ label: 'Manage Google account access', href: GOOGLE_PERMISSIONS_URL }],
      },
      {
        id: 'security',
        title: '8. Security',
        paragraphs: [
          'Connection tokens are encrypted at rest with authenticated encryption and are never written to logs or returned to the browser. Access to every workspace is checked on each request, and each Gmail request is made with the requesting member’s own connection only. No system is perfectly secure; if we learn of a breach affecting your data we will tell you as the law requires.',
        ],
      },
      {
        id: 'rights',
        title: '9. Your choices and rights',
        paragraphs: [
          'You can disconnect Gmail or any connected app at any time, turn off or delete memories in your profile, and ask us to access, correct, export or delete your personal information, or to restrict or object to how it is used, to the extent the law of your country gives you those rights. Because workspace content belongs to the organization that operates the workspace, some requests are handled together with that organization.',
        ],
      },
      {
        id: 'children',
        title: '10. Children',
        paragraphs: [`${productName} is a business tool for adults and is not directed at children.`],
      },
      {
        id: 'changes',
        title: '11. Changes',
        paragraphs: [
          'We may update this policy. The effective date above shows the current version, and we will give notice in the service of material changes before they take effect.',
        ],
      },
      {
        id: 'contact',
        title: '12. Contact',
        paragraphs: [contactParagraph(config)],
      },
    ],
  };
}

export function termsOfService(config: LegalConfig): LegalDocument {
  const { productName, entityName } = config;
  return {
    title: 'Terms of Service',
    effectiveDate: config.effectiveDate,
    intro: [
      `These terms govern your use of ${productName}, operated by ${entityName} ("we", "us"). By signing in or using the service you agree to them. If you use it on behalf of an organization, you confirm you may bind it.`,
    ],
    sections: [
      {
        id: 'service',
        title: '1. The service',
        paragraphs: [
          `${productName} is a platform for tracking companies and deals, managing relationships, and researching with an AI Copilot and AI workforce. Access is for authorized personnel and workspace members, for legitimate business use.`,
        ],
      },
      {
        id: 'accounts',
        title: '2. Accounts',
        bullets: [
          'Your account is personal. Do not share credentials or use anyone else’s session.',
          'Keep your sign-in details secure and tell us promptly if you suspect misuse.',
          'You are responsible for activity under your account.',
        ],
      },
      {
        id: 'acceptable-use',
        title: '3. Acceptable use',
        paragraphs: ['You agree not to:'],
        bullets: [
          'use the service for anything unlawful, or to infringe others’ rights;',
          'upload material you are not authorized to share, including personal or third-party confidential information unrelated to your work;',
          'probe, disrupt or circumvent the service’s security, limits or access controls;',
          'attempt to access another member’s data, mailbox or workspace;',
          'use the service to build a competing product or to train AI models.',
        ],
      },
      {
        id: 'content',
        title: '4. Your content',
        paragraphs: [
          `Content added to a workspace belongs to the organization that operates that workspace (for ${entityName}’s own workspaces, ${entityName}). You grant us the rights needed to host, process and display it to provide the service, including sending it to the AI and infrastructure providers described in the Privacy Policy. You are responsible for having the right to submit it.`,
        ],
      },
      {
        id: 'connected-apps',
        title: '5. Connected apps, including Gmail',
        bullets: [
          'Connecting an app such as Gmail is your choice, and you can disconnect it at any time. Gmail’s use of your data is described in the Privacy Policy.',
          'When you ask a bot to write an email and you have connected Gmail, it saves a draft in your Gmail. Nothing is sent until you press Send. You are responsible for reviewing a draft’s recipients, content and attachments before sending it.',
          'Email you receive is written by third parties and may contain inaccurate or malicious instructions. The Copilot treats it as information, not as commands, but you should still use judgement.',
          'Your use of Google services remains subject to Google’s own terms.',
        ],
      },
      {
        id: 'ai-output',
        title: '6. AI output',
        paragraphs: [
          'The Copilot and AI workforce can be wrong, incomplete or out of date. Output is provided for information and to assist your work. It is not investment, legal, tax or accounting advice, and you remain responsible for decisions you make and for verifying anything important against primary sources.',
        ],
      },
      {
        id: 'availability',
        title: '7. Availability and changes',
        paragraphs: [
          'We work to keep the service available but do not promise uninterrupted operation. We may change, add or remove features, including connected-app integrations, with reasonable notice where practical.',
        ],
      },
      {
        id: 'termination',
        title: '8. Suspension and termination',
        paragraphs: [
          'You may stop using the service at any time. We, or your workspace administrator, may suspend or end your access if you breach these terms, if your organization’s access ends, or if needed to protect the service or others. Sections that by their nature should survive (such as content ownership, disclaimers and liability) do.',
        ],
      },
      {
        id: 'disclaimers',
        title: '9. Disclaimers',
        paragraphs: [
          'The service is provided “as is” and “as available”. To the extent the law allows, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement.',
        ],
      },
      {
        id: 'liability',
        title: '10. Limitation of liability',
        paragraphs: [
          'To the extent the law allows, we are not liable for indirect, incidental, special, consequential or punitive damages, or for loss of profits, revenue, data or goodwill, arising from your use of the service. Nothing in these terms limits liability that cannot be limited by law.',
        ],
      },
      {
        id: 'law',
        title: '11. Governing law',
        paragraphs: [
          config.governingLaw
            ? `These terms are governed by the laws of ${config.governingLaw}.`
            : 'These terms are governed by the law that applies to the contract between you or your organization and us, as set out in that agreement.',
        ],
      },
      {
        id: 'changes',
        title: '12. Changes to these terms',
        paragraphs: [
          'We may update these terms. The effective date above shows the current version. Continuing to use the service after a change means you accept it; we will give notice in the service of material changes.',
        ],
      },
      {
        id: 'contact',
        title: '13. Contact',
        paragraphs: [contactParagraph(config)],
      },
    ],
  };
}
