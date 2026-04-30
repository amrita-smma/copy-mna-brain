import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { aiWorkforceEnabled } from '@/lib/flags';

export const metadata: Metadata = {
  title: 'BRAIN 2.0',
  description: 'Deal Pipeline Management',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const featureFlags = {
    aiWorkforceEnabled: Boolean(await aiWorkforceEnabled()),
  };

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers featureFlags={featureFlags}>{children}</Providers>
      </body>
    </html>
  );
}
