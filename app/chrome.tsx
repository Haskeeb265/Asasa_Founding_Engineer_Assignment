"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Open-plane shell: a labelled sidebar on the page ground on desktop; on a
 * phone a Binance-app-style bottom tab bar — icon + label, thumb distance,
 * active tab tinted. Icons render in the tab bar only (hidden on desktop).
 */

const NAV = [
  {
    href: "/",
    label: "User",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-3.5 3.8-6 8-6s8 2.5 8 6" />
      </svg>
    ),
  },
  {
    href: "/db",
    label: "Live database",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    ),
  },
] satisfies Array<{ href: string; label: string; icon: React.ReactNode }>;

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
            {item.icon}
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
