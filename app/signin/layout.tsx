import type { Metadata } from "next";

// /signin is a client component, so its metadata lives here.
export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to alpha. with just your email — we send a 6-digit code, no password to remember.",
};

export default function SigninLayout({ children }: { children: React.ReactNode }) {
  return children;
}
