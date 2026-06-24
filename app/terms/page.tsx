import { LegalLayout } from "@/components/LegalLayout";

export const metadata = {
  title: "Terms",
  description:
    "The terms of service for alpha. A $5/month personal letter, three times a week. Billing, cancellation, refunds, and what you can expect from the service.",
};

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" effectiveDate="May 13, 2026">
      <p>
        These terms govern your use of Alpha, a personal newsletter service
        ("Alpha", "we", "us"). By subscribing, you agree to them.
      </p>

      <H2>The service</H2>
      <p>
        Alpha is a paid email/web newsletter. You pick a set of topics, and
        three times a week we deliver a letter written for you by AI from real sources. Every link must come from a live web search made that period, a rule
        enforced in code. We may add features over time. We may also remove or
        change features when it makes the product better.
      </p>

      <H2>Subscription &amp; billing</H2>
      <ul>
        <li>Alpha starts at <strong>$5 per month, USD</strong> for 5 topics, billed
          monthly to your card. You can add bundles of 5 more topics for $5/mo each
          (up to 25 topics, $25/mo) from Settings → Billing.</li>
        <li>Your subscription auto-renews each month until you cancel.</li>
        <li>You can cancel any time from Settings → Billing. Cancellation takes
          effect at the end of the current billing cycle. You keep access until then.</li>
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
        Alpha is informational. It is not financial advice, medical advice, legal
        advice, or professional counsel. Items in your letter come from public
        sources and we work hard to source carefully, but we can&apos;t guarantee
        that every fact, link, or recommendation is current or correct. Verify
        anything important before acting on it.
      </p>

      <H2>Acceptable use</H2>
      <p>Don&apos;t use Alpha to:</p>
      <ul>
        <li>Harass others or send spam.</li>
        <li>Attempt to break into accounts that aren&apos;t yours.</li>
        <li>Resell or redistribute the service.</li>
        <li>Scrape the platform at scale.</li>
      </ul>
      <p>We may suspend accounts that do.</p>

      <H2>Account &amp; security</H2>
      <p>
        Keep your magic-link email private. If your account is compromised, email us
        and we&apos;ll revoke all active sessions.
      </p>

      <H2>Disclaimers</H2>
      <p>
        Alpha is provided &quot;as is.&quot; We make no warranties about uptime,
        accuracy, or fitness for any particular purpose. To the maximum extent
        permitted by law, our liability for any claim related to the service is
        limited to the amount you paid us in the previous twelve months.
      </p>

      <H2>Changes to these terms</H2>
      <p>
        If we change these terms in a material way, we&apos;ll email you in advance
        of the change. Continued use after a change means you accept the new terms.
      </p>

      <H2>Governing law</H2>
      <p>These terms are governed by the laws of the State of Florida, USA.</p>

      <H2>Contact</H2>
      <p>Questions: <a href="mailto:youngalgy@gmail.com">youngalgy@gmail.com</a>.</p>

      <hr className="opacity-30 my-8" />
      <p className="text-sm italic" style={{ color: "var(--ink-soft)" }}>
        These terms are written in plain language and represent a first-pass
        agreement. They have not been reviewed by an attorney. Before Alpha takes
        its first paying user we&apos;ll have these professionally reviewed.
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
