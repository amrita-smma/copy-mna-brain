import Link from 'next/link';
import { BrandWordmark } from '@/components/BrandMark';
import type { LegalDocument } from '@/lib/legal/documents';

/**
 * A standalone public page (no app shell, no session): the header carries the
 * brand and links to the other legal page and to sign-in. The document's title
 * is the page's only `<h1>`; section titles are `<h2>`.
 */
export function LegalDocumentView({ document, current }: { document: LegalDocument; current: 'privacy' | 'terms' }) {
  const links = [
    { href: '/privacy', label: 'Privacy Policy', key: 'privacy' },
    { href: '/terms', label: 'Terms of Service', key: 'terms' },
  ] as const;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <Link href="/" aria-label="Investment Brain home">
            <BrandWordmark className="h-7 w-auto" />
          </Link>
          <nav aria-label="Legal" className="flex items-center gap-4 text-sm">
            {links.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                aria-current={link.key === current ? 'page' : undefined}
                className={link.key === current ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}
              >
                {link.label}
              </Link>
            ))}
            <Link href="/login" className="text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="font-display text-3xl font-bold tracking-tight">{document.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Effective {document.effectiveDate}</p>

        <div className="mt-8 space-y-4 leading-relaxed">
          {document.intro.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        <nav aria-label="Contents" className="mt-8 rounded-md border border-border bg-muted p-4">
          <h2 className="mb-2 text-sm font-semibold">Contents</h2>
          <ol className="grid gap-1 text-sm sm:grid-cols-2">
            {document.sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-muted-foreground hover:text-foreground">
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          {document.sections.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-6">
              <h2 className="font-display text-xl font-semibold tracking-tight">{section.title}</h2>
              <div className="mt-3 space-y-3 leading-relaxed">
                {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {section.bullets && (
                  <ul className="list-disc space-y-2 pl-5">
                    {section.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                )}
                {section.links?.map((link) => (
                  <p key={link.href}>
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-4"
                    >
                      {link.label}
                    </a>
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto max-w-3xl px-6 py-6 text-xs text-muted-foreground">
          © {new Date().getFullYear()} Investment Brain
        </div>
      </footer>
    </div>
  );
}
