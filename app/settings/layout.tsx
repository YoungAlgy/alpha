import type { Metadata } from "next";

// /settings (and /settings/accounts, /settings/changelog via nesting) is
// signed-in-only account management -- not meant to be indexed. Client
// component, so its metadata lives here instead.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
