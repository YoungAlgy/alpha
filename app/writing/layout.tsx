import type { Metadata } from "next";

// /writing is the mid-generation loading screen for a paid signup in
// progress -- never a page worth indexing. Client component, so its
// metadata lives here instead.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function WritingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
