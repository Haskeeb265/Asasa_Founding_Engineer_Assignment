"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Open-plane shell (achromatic-ledger): a labelled sidebar on the page ground
 * on desktop; on a phone the nav folds into a fixed bottom tab bar — thumb
 * distance, two taps, no hunting for a hamburger.
 */

const NAV = [
  { href: "/", label: "User", dot: true },
  { href: "/db", label: "Live database", dot: true },
];

function NavItems({ stacked }: { stacked?: boolean }) {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item${active ? " is-active" : ""}${stacked ? " is-stacked" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="nav-dot" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

function Mark() {
  return (
    <div className="mark">
      <span className="mark-glyph" aria-hidden="true">
        A
      </span>
      <span className="mark-name">Asasa</span>
    </div>
  );
}

export function AppShell({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Mark />
        <NavItems stacked />
        <p className="nav-note">Single-user demo at live market prices. No auth; refresh to reboot state.</p>
      </aside>

      <header className="topbar">
        <span className="topbar-name">Asasa</span>
        <span className="topbar-page">{title}</span>
      </header>

      <main className="canvas">
        <div className="canvas-inner">
          <h1 className="page-title">{title}</h1>
          {sub ? <p className="page-sub">{sub}</p> : null}
          {children}
        </div>
      </main>

      <nav className="bottombar" aria-label="Main">
        <NavItems />
      </nav>
    </div>
  );
}
