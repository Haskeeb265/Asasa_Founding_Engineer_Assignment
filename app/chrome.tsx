"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * Open-plane shell (achromatic-ledger): a labelled sidebar on the page ground,
 * no top bar on desktop; on a phone it folds into a 48px bar that opens a
 * full-screen nav sheet.
 */

const NAV = [
  { href: "/", label: "User", dot: true },
  { href: "/db", label: "Live database", dot: true },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
          >
            <span className="nav-dot" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
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
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="shell">
      <aside className="sidebar">
        <Mark />
        <NavItems />
        <p className="nav-note">Single-user demo at live market prices. No auth; refresh to reboot state.</p>
      </aside>

      <div className="topbar-wrap">
        <div className="topbar">
          <span className="topbar-name">Asasa</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSheetOpen(true)}
            aria-expanded={sheetOpen}
          >
            Menu
          </button>
        </div>
        {sheetOpen ? (
          <div className="nav-sheet">
            <Mark />
            <NavItems onNavigate={() => setSheetOpen(false)} />
            <button type="button" className="nav-sheet-close" onClick={() => setSheetOpen(false)}>
              Close
            </button>
          </div>
        ) : null}
      </div>

      <main className="canvas">
        <div className="canvas-inner">
          <h1 className="page-title">{title}</h1>
          {sub ? <p className="page-sub">{sub}</p> : null}
          {children}
        </div>
      </main>
    </div>
  );
}
