import type { ReactNode } from 'react';

export const metadata = {
  title: 'Asasa Gold — Buy & Sell 24K Gold',
  description: 'Live 24K gold pricing, locked quotes, and settled trade receipts.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0D4A46',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#F9FAFA' }}>{children}</body>
    </html>
  );
}
