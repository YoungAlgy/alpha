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
          <strong>Optional personalization:</strong> your birthday and gender, if
          you choose to share them. Both are optional and only tune the letter
          (which topics unlock, how it&apos;s voiced) — birthday unlocks the daily
          Zodiac topic and, as a broad generation label like &quot;Millennial&quot;
          (never the exact date), shapes tone.
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
          views) and error reports when something breaks in your browser, only
          if we&apos;ve turned it on for the app. Off by default. Used only to
          improve the product, never sold. We don&apos;t track which
          individual letters you read or collect device fingerprinting. Error
          reports carry a technical description of what went wrong (never
          anything you typed into a form), and any email address that
          somehow ends up in one is stripped before it&apos;s recorded.
        </li>
      </ul>

      <H2>How we use it</H2>
      <p>
        We use your data only to (a) generate and deliver your letters,
        (b) bill your subscription, and (c) improve alpha. We don&apos;t share it
        with advertisers. Our primary AI provider, Anthropic, runs on a paid
        tier that doesn&apos;t use your data to train their models. The free
        backup providers we fall back to (see below) don&apos;t carry that
        same guarantee.
      </p>

      <H2>Third-party processors</H2>
      <p>We rely on a small set of trusted services:</p>
      <ul>
        <li>
          <strong>Stripe</strong> handles all payment information. We never see your
          card number.
        </li>
        <li>
          <strong>Anthropic (Claude)</strong> writes the short editor&apos;s note at
          the top of your letter — the one part of the letter built from your
          name, city, topic prefs, gender, a generation label derived from
          your birthday (like &quot;Millennial,&quot; never the exact date),
          and any optional job/project/fun context you shared, so the note
          feels written for you. Anthropic runs on a paid tier that does not
          retain that data for training. Anthropic can also write a topic
          section itself, as the last-resort tier if the writers below all
          come up short for that topic — in that role it never sees your
          profile, only the topic and that day&apos;s research, same as the
          writers below.
        </li>
        <li>
          <strong>Google (Gemini), Groq, and DeepSeek</strong> write each day&apos;s
          topic sections first, cheapest-tier first, with Anthropic stepping in
          only if all three come up short. None of the four ever see your
          profile when writing a topic section — only the topic itself and
          that day&apos;s research. Gemini, Groq, and DeepSeek also back up the
          editor&apos;s note if Anthropic is briefly down; in that specific
          role, whichever one steps in sees the same profile fields
          Anthropic&apos;s own editor&apos;s note does. We use Google&apos;s free Gemini
          API tier for this, and Google&apos;s own terms for that free tier allow
          them to use what we send to improve their products — unlike
          Anthropic&apos;s paid-tier guarantee above, we can&apos;t promise Google
          won&apos;t.
        </li>
        <li>
          <strong>Brave Search</strong>, with <strong>Google (Gemini)</strong> and{" "}
          <strong>You.com</strong> as backups, finds the sources your letter links
          to. Your topic picks go out as search queries; nothing else about you
          does — except the Zodiac topic, whose query is built from the sun
          sign your birthday puts you in (never the date itself).
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
        We use the cookies needed to keep you logged in. Your theme choice is
        remembered in your browser&apos;s local storage instead (and in your
        account, once you&apos;re signed in) — not a cookie. No advertising
        cookies. If we&apos;ve turned on product analytics for the app, that
        tool sets its own first-party cookie too, just to tell your visits
        apart from someone else&apos;s — same rules as the analytics itself:
        never sold, off by default. Source links in your letters show a small
        site icon loaded from Google&apos;s public favicon service, which
        sees the domain of the article but nothing else about you.
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
