import type { Metadata } from "next";
import { LegalLayout } from "@/components/LegalLayout";

// alpha-drift-r15-08/10: see app/privacy/page.tsx's comment -- same fix,
// same reason (indexable page silently inheriting the root layout's
// homepage openGraph/twitter/canonical).
//
// alpha-drift-r28-03 (2026-08-15): see app/privacy/page.tsx's comment --
// same fix, same reason (that same replace-not-merge behavior also dropped
// images/siteName, unnoticed for 13 rounds).
const PATH = "/terms";
const TITLE = "Terms";
const DESCRIPTION =
  "The terms of service for alpha. A $5/month personal letter, every day. Billing, cancellation, refunds, and what you can expect from the service.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `https://alpha.everyday.report${PATH}` },
  openGraph: {
    title: `${TITLE} | alpha.`,
    description: DESCRIPTION,
    url: `https://alpha.everyday.report${PATH}`,
    type: "website",
    siteName: "alpha.",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "alpha. your alpha" }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} | alpha.`,
    description: DESCRIPTION,
    images: ["/og-image.png"],
  },
};

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" effectiveDate="May 13, 2026">
      <p>
        These terms govern your use of alpha. ("we," "us"), a personal
        newsletter service. By subscribing, you agree to them.
      </p>

      <H2>The service</H2>
      {/* alpha-drift-r24-05 (2026-08-14): the resend-your-most-recent-letter
      fallback needs a prior letter to resend, so it can't cover a brand-new
      subscriber's very first one (app/api/cron/weekly-send/route.ts's own
      LAYER 2 comment says as much: "No prior letter... stays a hard failure").
      Added the caveat below rather than promise something the first send
      can't keep. */}
      <p>
        alpha. is a paid email/web newsletter. You pick a set of topics, and
        every day we deliver a letter written for you by AI from real sources,
        with every link starting as a live web search made that period. On a
        rare day something upstream breaks and we can&apos;t finish a fresh
        letter in time. Rather than send nothing, we&apos;ll resend your most
        recent one and say so plainly in the letter itself. That fallback
        needs a letter of yours already on file, so it doesn&apos;t apply to
        your very first one as a new subscriber. On the rare day that first
        letter fails to generate, you simply won&apos;t get one that day, and
        we try again on the next scheduled send. We may add features over
        time. We may also remove or change features when it makes the product
        better.
      </p>

      <H2>Subscription &amp; billing</H2>
      <ul>
        <li>alpha. starts at <strong>$5 per month, USD</strong> for 5 topics, billed
          monthly to your card. You can add bundles of 5 more topics for $5/mo each
          (up to 25 topics, $25/mo) from Settings → Billing.</li>
        <li>Your subscription auto-renews each month until you cancel.</li>
        {/* alpha-drift-r24-03 (2026-08-14): this used to name Settings → Billing as
        the normal path and email as a fallback "if that button doesn't work." Live-
        checked via Stripe: the account has zero Billing Portal configurations, so the
        button always fails and email is the only path that works today. Rewritten to
        lead with email and describe the button with an "if it's live for you" hedge,
        so this stays accurate both now and once the one-time Stripe dashboard config
        (tracked separately, needs Algy) is done. */}
        <li>You can cancel any time. Email us and we&apos;ll cancel it the same day,
          no back and forth. There&apos;s also a Manage subscription button in
          Settings → Billing for instant self-serve cancellation and card updates,
          when it&apos;s live for your account. Either way, cancellation takes effect
          at the end of the current billing cycle and you keep access until then.</li>
        <li>We don&apos;t prorate partial-month refunds, but if something has gone
          materially wrong on our end, email us and we&apos;ll make it right.</li>
      </ul>

      <H2>What you can and can&apos;t do with letters</H2>
      <ul>
        <li>You can read, save, screenshot, and share your letters with friends.</li>
        <li>You can&apos;t republish them in bulk, repackage them as your own product,
          or use them to train machine-learning models.</li>
        <li>The voice, design, and editorial choices are ours. The topic selections
          and personalization details are yours.</li>
      </ul>

      <H2>What we don&apos;t do</H2>
      <p>
        {/* alpha-drift-r36-08 (2026-08-14): "professional counsel" is
        thesaurus-legal after three plain items in the same list -- nobody
        says it out loud, and the sentence right after this one is some of
        the plainest writing on the page. */}
        alpha. is informational. It is not financial advice, medical advice, legal
        advice, or any other kind of professional advice. Items in your letter come from public
        sources and we work hard to source carefully, but we can&apos;t guarantee
        that every fact, link, or recommendation is current or correct. Verify
        anything important before acting on it.
      </p>

      <H2>Acceptable use</H2>
      <p>Don&apos;t use alpha. to:</p>
      <ul>
        <li>Harass others or send spam.</li>
        <li>Attempt to break into accounts that aren&apos;t yours.</li>
        <li>Resell or redistribute the service.</li>
        <li>Scrape the platform at scale.</li>
      </ul>
      <p>We may suspend accounts that do.</p>

      <H2>Account &amp; security</H2>
      <p>
        {/* alpha-drift-r20-07 (found+fixed 2026-08-13): this used to promise
            we'd "revoke all active sessions" on a compromised account -- no
            such action exists anywhere in the codebase (the admin panel can
            delete, grant free, or revoke free; every sign-out is self-serve).
            Deleting the account is the real lever: it blocks future sign-in
            immediately and (since the alpha-drift-r20-05 fix) also cuts off
            an already-signed-in session on another device the next time it
            tries to load a letter. Promise what we can actually do. */}
        Keep your magic-link email private. If your account is compromised, email us
        and we&apos;ll delete it so you can start fresh with a new one.
      </p>

      <H2>Disclaimers</H2>
      <p>
        alpha. is provided &quot;as is.&quot; We make no warranties about uptime,
        accuracy, or fitness for any particular purpose. To the maximum extent
        permitted by law, our liability for any claim related to the service is
        limited to the amount you paid us in the previous twelve months.
      </p>

      <H2>Changes to these terms</H2>
      {/* alpha-drift-r36-09 (2026-08-14): matched to app/privacy/page.tsx's
      sibling wording for the identical promise ("we'll email you before
      the change takes effect") -- was phrased two different ways for the
      same thing across the two pages. */}
      <p>
        If we change these terms in a material way, we&apos;ll email you before
        the change takes effect. Continued use after a change means you accept the new terms.
      </p>

      <H2>Governing law</H2>
      <p>These terms are governed by the laws of the State of Florida, USA.</p>

      <H2>Contact</H2>
      <p>Questions: <a href="mailto:youngalgy@gmail.com">youngalgy@gmail.com</a>.</p>

      <hr className="opacity-30 my-8" />
      <p className="text-sm italic" style={{ color: "var(--ink-soft)" }}>
        These terms are written in plain language and represent a first-pass
        agreement. They have not been reviewed by an attorney yet.
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
