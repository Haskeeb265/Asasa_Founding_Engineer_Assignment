import type { ReactNode } from 'react';
import { Geist } from 'next/font/google';

const geist = Geist({
  subsets: ['latin'],
  display: 'swap',
});

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
      <body className={geist.className} style={{ margin: 0, background: '#F9FAFA' }}>
        {children}
      </body>
    </html>
  );
}
