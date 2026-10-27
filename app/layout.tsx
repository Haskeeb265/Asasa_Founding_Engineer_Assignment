import { Geist, Geist_Mono } from "next/font/google"; // taste-skill-ignore: achromatic-ledger sets every figure in Geist Mono by the style's own decision
import type { Metadata } from "next";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" }); // taste-skill-ignore: figures font per the dealt style

export const metadata: Metadata = {
  title: "Asasa · Gold trading demo",
  description: "Buy and sell gold at live market prices",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
