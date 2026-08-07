import type { Metadata } from "next";

// /welcome is a client component, so its metadata lives here. Indexable (the
// onboarding front door) — give it a real title + description instead of
// inheriting the layout defaults.
//
// alpha-drift-r15-08/10: see app/privacy/page.tsx's comment -- same fix,
// same reason (indexable page silently inheriting the root layout's
// homepage openGraph/twitter/canonical).
const PATH = "/welcome";
const TITLE = "Start your letter";
const DESCRIPTION =
  "Set up your alpha. in a couple of minutes: pick your topics, choose a look, and get your first personal letter on the spot. $5 a month.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `https://alpha.everyday.report${PATH}` },
  openGraph: {
    title: `${TITLE} | alpha.`,
    description: DESCRIPTION,
    url: `https://alpha.everyday.report${PATH}`,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: `${TITLE} | alpha.`,
    description: DESCRIPTION,
  },
};

export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
