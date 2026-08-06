import type { Metadata } from "next";

// /inbox is a signed-in reader's private letter -- crawlable per robots.ts's
// Disallow doesn't guarantee NOT indexed (a URL discovered via a link can
// still get indexed with a blank snippet if Google can't crawl it to see a
// noindex it's blocked from reaching). This is a client component, so its
// metadata lives here instead.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return children;
}
