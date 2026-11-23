import type { ReactNode } from 'react';

export const metadata = {
  title: 'Asasa Gold — Test Console',
  description: 'Single-user gold buy/sell demo console.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
