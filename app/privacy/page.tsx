import type { Metadata } from "next";
import { LegalLayout } from "@/components/LegalLayout";

// alpha-drift-r15-08/10 (found+fixed 2026-08-06): this page is in both
// robots.ts's allow list and sitemap.ts, but only ever set flat
// title/description -- Next doesn't deep-merge openGraph/twitter across
// route segments, so it silently inherited the ROOT layout's whole object
// (og:title/og:url literally identified this page as the homepage, verified
// live via curl). canonical was also missing -- app/page.tsx and
// app/sample/page.tsx both set alternates.canonical deliberately; this page
// never did.
const PATH = "/privacy";
const TITLE = "Privacy";
const DESCRIPTION =
  "How alpha. handles your data: what we store, what we never do with it (no ads, no selling), and how deletion works.";

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

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy" effectiveDate="May 13, 2026">
      <p>
        alpha. is a personal newsletter service. We try to collect as little
        about you as we need to write you a good letter, and we don&apos;t sell or share
        your data with advertisers. Ever.
      </p>

      <H2>What we collect</H2>
      <p>When you sign up and use alpha., we store:</p>
      <ul>
        <li>
          <strong>Account basics:</strong> your first name, email address, and city.
        </li>
        <li>
          <strong>Your interests:</strong> the topics you picked (5-25 depending on
          your plan tier), your chosen theme, and any optional context you shared
          (what you do, what you&apos;re working on, a non-work interest).
        </li>
        <li>
          <strong>Letters we write you:</strong> a copy of each letter is saved
          to your account so you can re-read past issues.
        </li>
        <li>
          <strong>Usage signals:</strong> basic product analytics (like page
          views), only if we&apos;ve turned it on for the app. Off by default.
          Used only to improve the product, never sold. We don&apos;t track
          which individual letters you read or collect device fingerprinting.
        </li>
      </ul>

      <H2>How we use it</H2>
      <p>
        We use your data only to (a) generate and deliver your letters,
        (b) bill your subscription, and (c) improve alpha. We don&apos;t use it to
        train external machine-learning models, and we don&apos;t share it with
        advertisers.
      </p>

      <H2>Third-party processors</H2>
      <p>We rely on a small set of trusted services:</p>
      <ul>
        <li>
          <strong>Stripe</strong> handles all payment information. We never see your
          card number.
        </li>
        <li>
          <strong>Anthropic (Claude)</strong> generates the content of your letter
          from publicly-sourced material. Your name, city, and topic prefs are
          included in the generation request so the letter feels written for you;
          Anthropic does not retain that data for training.
        </li>
        <li>
          <strong>Google (Gemini), Groq, and DeepSeek</strong> are backup writers.
          If Anthropic is down or unavailable, we automatically fall back to one
          of these so your letter still arrives. They see the same name, city,
          and topic prefs Anthropic does, only when a fallback actually fires.
        </li>
        <li>
          <strong>Brave Search</strong>, with <strong>Google (Gemini)</strong> as a
          backup, finds the sources your letter links to. Your topic picks go
          out as search queries; nothing else about you does.
        </li>
        <li>
          <strong>Resend</strong> delivers letters and account emails.
        </li>
        <li>
          <strong>Supabase</strong> stores your account and letter history securely.
        </li>
        <li>
          <strong>Cloudflare</strong> hosts the web app.
        </li>
      </ul>

      <H2>Your rights</H2>
      <p>You can, at any time:</p>
      <ul>
        <li>Download a copy of everything we have about you from Settings → Account.</li>
        <li>Delete your account and all associated data (irreversible) from the same place.</li>
        <li>Email us to revoke any consent or ask what we have.</li>
      </ul>

      <H2>Cookies</H2>
      <p>
        We use the cookies needed to keep you logged in and remember your
        theme. No advertising cookies. If we&apos;ve turned on product
        analytics for the app, that tool sets its own first-party cookie too,
        just to tell your visits apart from someone else&apos;s — same rules
        as the analytics itself: never sold, off by default. Source links in
        your letters show a small site icon loaded from Google&apos;s public
        favicon service, which sees the domain of the article but nothing
        else about you.
      </p>

      <H2>Children</H2>
      <p>alpha. is for adults. We do not knowingly collect data from anyone under 13.</p>

      <H2>Changes to this policy</H2>
      <p>
        If we materially change how we handle your data, we&apos;ll email you
        before the change takes effect.
      </p>

      <H2>Contact</H2>
      <p>
        Privacy questions or requests: <a href="mailto:youngalgy@gmail.com">
        youngalgy@gmail.com</a>.
      </p>

      <hr className="opacity-30 my-8" />
      <p className="text-sm italic" style={{ color: "var(--ink-soft)" }}>
        This policy is a plain-English description of how alpha. handles your
        information. It does not constitute legal advice. We recommend reviewing
        the Terms of Service for the full agreement.
      </p>
    </LegalLayout>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="alpha-display text-2xl md:text-3xl font-bold tracking-tight mt-10 mb-3">
      {children}
    </h2>
  );
}
