import type { Metadata } from "next";

// See app/name/layout.tsx for why every onboarding step page gets this.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ThemeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
