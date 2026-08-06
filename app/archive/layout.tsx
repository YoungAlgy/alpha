import type { Metadata } from "next";

// /archive lists a signed-in reader's own past letters -- private, not meant
// to be indexed. Client component, so its metadata lives here instead.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ArchiveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
