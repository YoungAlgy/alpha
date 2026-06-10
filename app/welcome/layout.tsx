import type { Metadata } from "next";

// /welcome is a client component, so its metadata lives here. Indexable (the
// onboarding front door) — give it a real title + description instead of
// inheriting the layout defaults.
export const metadata: Metadata = {
  title: "Start your letter",
  description:
    "Set up your alpha. in a couple of minutes: pick your topics, choose a look, and get your first personal letter this Sunday. $5 a month.",
};

export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
