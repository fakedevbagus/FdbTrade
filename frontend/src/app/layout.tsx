import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";

import { executionStatusLabel, siteConfig } from "@/lib/site-config";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.tagline,
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <html lang="en">
      <body>
        <a className="fdb-skip-link" href="#fdb-main">
          Skip to content
        </a>
        <header className="fdb-header">
          <div className="fdb-container fdb-header__inner">
            <span className="fdb-brand">{siteConfig.name}</span>
            <nav aria-label="Primary">
              <ul className="fdb-nav">
                {siteConfig.nav.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href}>{item.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </header>
        <main id="fdb-main" className="fdb-main">
          {children}
        </main>
        <footer className="fdb-footer">
          <div className="fdb-container fdb-footer__inner">
            <span>{siteConfig.tagline}</span>
            <span>
              Live execution: {executionStatusLabel} &middot; All timestamps are
              UTC
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
