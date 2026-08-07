import type { Metadata } from "next";

// alpha-drift-r15-09 (found+fixed 2026-08-06): robots.ts disallows /auth/,
// but /auth/callback/page.tsx is a client component with no metadata of its
// own and (until this file) no app/auth/layout.tsx to carry one -- it fell
// through to the root layout's metadata, which never sets `robots`, so this
// was the one route in the whole robots.ts disallow list indexable by
// default. Every sibling disallowed route (app/inbox/layout.tsx,
// app/archive/layout.tsx, app/settings/layout.tsx, etc.) sets this same
// defense-in-depth noindex explicitly -- see app/inbox/layout.tsx's own
// comment for why robots.ts's Disallow alone isn't enough (a URL discovered
// via a link can still get indexed with a blank snippet if Google can't
// crawl it to see a noindex it's blocked from reaching).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
