import { describe, it, expect } from 'vitest';

import {
  CHAT_ATTACHMENT_UPLOADED,
  CHAT_LINK_CLICKED,
  CHAT_MESSAGE_SENT,
  CHAT_NAVIGATION_CLICKED,
  attachmentKind,
  chatAttachmentProperties,
  chatLinkProperties,
  chatMessageSentProperties,
  chatNavigationProperties,
  classifyLink,
  fileExtension,
  linkTextOf,
} from './posthog-chat';

describe('chat event names', () => {
  it('are the exact strings the PostHog insights filter on', () => {
    // Renaming any of these silently breaks every saved insight — the test is
    // here so the rename has to be deliberate.
    expect(CHAT_MESSAGE_SENT).toBe('chat_message_sent');
    expect(CHAT_LINK_CLICKED).toBe('chat_link_clicked');
    expect(CHAT_NAVIGATION_CLICKED).toBe('chat_navigation_clicked');
    expect(CHAT_ATTACHMENT_UPLOADED).toBe('chat_attachment_uploaded');
  });
});

describe('classifyLink', () => {
  it('treats an absolute http(s) URL as external and keeps its host', () => {
    expect(classifyLink('https://www.reuters.com/article/x?y=1')).toEqual({
      link_url: 'https://www.reuters.com/article/x?y=1',
      link_host: 'www.reuters.com',
      link_kind: 'external',
    });
  });

  it('treats a root-relative path as internal with no host', () => {
    expect(classifyLink('/w/acme/pipeline')).toEqual({
      link_url: '/w/acme/pipeline',
      link_host: null,
      link_kind: 'internal',
    });
  });

  it('classifies anchors, mailto and tel separately', () => {
    expect(classifyLink('#section').link_kind).toBe('anchor');
    expect(classifyLink('mailto:deals@example.com').link_kind).toBe('mailto');
    expect(classifyLink('tel:+622112345').link_kind).toBe('tel');
  });

  it('returns unknown for an empty, missing or unparseable href', () => {
    expect(classifyLink(undefined)).toEqual({
      link_url: null,
      link_host: null,
      link_kind: 'unknown',
    });
    expect(classifyLink('   ')).toEqual({ link_url: null, link_host: null, link_kind: 'unknown' });
    expect(classifyLink('not a url').link_kind).toBe('unknown');
  });

  it('does not report a non-web protocol as external', () => {
    expect(classifyLink('javascript:alert(1)').link_kind).toBe('unknown');
    expect(classifyLink('javascript:alert(1)').link_host).toBeNull();
  });

  it('trims surrounding whitespace before classifying', () => {
    expect(classifyLink('  https://example.com/a  ').link_kind).toBe('external');
  });
});

describe('linkTextOf', () => {
  it('returns a plain string child as-is', () => {
    expect(linkTextOf('Reuters')).toBe('Reuters');
  });

  it('joins the string leaves of a mixed children array', () => {
    expect(linkTextOf(['see ', { props: { children: 'this' } }, ' here'])).toBe('see this here');
  });

  it('descends into a single element child', () => {
    expect(linkTextOf({ props: { children: ['Q3 ', 'report'] } })).toBe('Q3 report');
  });

  it('returns null for empty or non-textual children', () => {
    expect(linkTextOf('')).toBeNull();
    expect(linkTextOf(undefined)).toBeNull();
    expect(linkTextOf(null)).toBeNull();
    expect(linkTextOf([])).toBeNull();
  });

  it('keeps numeric leaves, which markdown footnote links use', () => {
    expect(linkTextOf([1])).toBe('1');
  });
});

describe('chatLinkProperties', () => {
  it('merges the link classification with the surface and trimmed link text', () => {
    expect(
      chatLinkProperties({
        href: 'https://example.com/report.pdf',
        surface: 'copilot',
        linkText: '  Q3 report  ',
      }),
    ).toEqual({
      link_url: 'https://example.com/report.pdf',
      link_host: 'example.com',
      link_kind: 'external',
      surface: 'copilot',
      link_text: 'Q3 report',
    });
  });

  it('truncates very long link text so the property stays queryable', () => {
    const text = 'a'.repeat(200);
    const props = chatLinkProperties({ href: '/x', surface: 'widget', linkText: text });
    expect(props.link_text).toBe(`${'a'.repeat(120)}…`);
  });

  it('nulls link text when it is absent or blank', () => {
    expect(chatLinkProperties({ href: '/x', surface: 'copilot' }).link_text).toBeNull();
    expect(
      chatLinkProperties({ href: '/x', surface: 'copilot', linkText: '   ' }).link_text,
    ).toBeNull();
  });
});

describe('chatNavigationProperties', () => {
  it('records the affordance, destination and company', () => {
    expect(
      chatNavigationProperties({
        source: 'company_chip',
        path: '/pipeline?company=abc',
        companyId: 'abc',
        label: 'Acme Corp',
      }),
    ).toEqual({
      source: 'company_chip',
      destination_path: '/pipeline?company=abc',
      company_id: 'abc',
      label: 'Acme Corp',
    });
  });

  it('nulls company_id for destinations that are not a company', () => {
    expect(
      chatNavigationProperties({ source: 'workforce_handoff', path: '/ai-workforce' }),
    ).toEqual({
      source: 'workforce_handoff',
      destination_path: '/ai-workforce',
      company_id: null,
      label: null,
    });
  });
});

describe('attachmentKind', () => {
  it('splits images, PDFs and everything else', () => {
    expect(attachmentKind('image/png')).toBe('image');
    expect(attachmentKind('application/pdf')).toBe('pdf');
    expect(attachmentKind('application/vnd.ms-excel')).toBe('document');
  });

  it('is case-insensitive and defaults to document when the type is missing', () => {
    expect(attachmentKind('IMAGE/JPEG')).toBe('image');
    expect(attachmentKind(undefined)).toBe('document');
    expect(attachmentKind('')).toBe('document');
  });
});

describe('fileExtension', () => {
  it('returns the lowercased extension', () => {
    expect(fileExtension('Teaser Deck.PPTX')).toBe('pptx');
    expect(fileExtension('a.b.csv')).toBe('csv');
  });

  it('returns null when there is no usable extension', () => {
    expect(fileExtension('README')).toBeNull();
    expect(fileExtension('.gitignore')).toBeNull();
    expect(fileExtension('trailing.')).toBeNull();
    expect(fileExtension(undefined)).toBeNull();
  });
});

describe('chatAttachmentProperties', () => {
  it('describes the uploaded file by kind, extension and size', () => {
    expect(
      chatAttachmentProperties({
        fileName: 'IM.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        surface: 'copilot',
      }),
    ).toEqual({
      file_name: 'IM.pdf',
      content_type: 'application/pdf',
      file_kind: 'pdf',
      file_extension: 'pdf',
      size_bytes: 2048,
      surface: 'copilot',
    });
  });
});

describe('chatMessageSentProperties', () => {
  it('derives has_attachments from the count', () => {
    const withFiles = chatMessageSentProperties({
      chatId: 'c1',
      isNewChat: true,
      effort: 'high',
      attachmentCount: 2,
      messageLength: 42,
      copilotAgent: 'mna',
      hasPageContext: true,
      pageContextTab: 'pipeline',
    });
    expect(withFiles).toEqual({
      chat_id: 'c1',
      is_new_chat: true,
      effort: 'high',
      attachment_count: 2,
      has_attachments: true,
      message_length: 42,
      copilot_agent: 'mna',
      has_page_context: true,
      page_context_tab: 'pipeline',
    });
  });

  it('nulls the page-context tab when the turn carried no page context', () => {
    const props = chatMessageSentProperties({
      chatId: 'c2',
      isNewChat: false,
      effort: 'medium',
      attachmentCount: 0,
      messageLength: 5,
      copilotAgent: 'investment',
      hasPageContext: false,
    });
    expect(props.has_attachments).toBe(false);
    expect(props.page_context_tab).toBeNull();
  });
});
