import type { Metadata } from "next";

// Onboarding step pages (/name, /city, /role, /focus, /topics, /theme, /fun,
// /you, /email, /checkout) are mid-funnel, session-dependent steps -- not
// worth indexing on their own; /welcome is the real front door. Client
// component, so its metadata lives here instead.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function NameLayout({ children }: { children: React.ReactNode }) {
  return children;
}
