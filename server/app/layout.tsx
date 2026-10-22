import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Art Online", template: "%s | Art Online" },
  description: "Original work, sold directly by the artists who made it.",
  metadataBase: process.env.APP_URL ? new URL(process.env.APP_URL) : undefined,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="site-header">
          <Link href="/" className="wordmark">Art Online</Link>
          <nav aria-label="Main">
            <Link href="/">Browse</Link>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <p>Art Online is a marketplace for independent artists in Kenya.</p>
        </footer>
      </body>
    </html>
  );
}
