import type { ReactNode } from "react";

export const metadata = {
  title: "Asasa — Gold Trading Demo",
  description: "Buy and sell gold at live market prices",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
