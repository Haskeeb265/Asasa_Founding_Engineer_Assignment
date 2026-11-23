import type { ReactNode } from 'react';

export const metadata = {
  title: 'Asasa Gold Trading Demo — API',
  description: 'Backend-only single-user gold buy/sell demo.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
