import type { Metadata } from "next";

// /signin is a client component, so its metadata lives here.
//
// alpha-drift-r15-08/10: see app/privacy/page.tsx's comment -- same fix,
// same reason (indexable page silently inheriting the root layout's
// homepage openGraph/twitter/canonical).
const PATH = "/signin";
const TITLE = "Sign in";
const DESCRIPTION =
  "Sign in to alpha. with just your email. We send a 6-digit code, no password to remember.";

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

export default function SigninLayout({ children }: { children: React.ReactNode }) {
  return children;
}
