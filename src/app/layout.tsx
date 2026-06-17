import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import { aiWorkforceEnabled } from '@/lib/flags';

export const metadata: Metadata = {
  title: 'BRAIN 2.0',
  description: 'Deal Pipeline Management',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'BRAIN 2.0',
  },
  icons: {
    icon: '/favicon.ico',
    apple: '/icons/apple-icon-180.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
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
        <ServiceWorkerRegister />
        <Providers featureFlags={featureFlags}>{children}</Providers>
      </body>
    </html>
  );
}
