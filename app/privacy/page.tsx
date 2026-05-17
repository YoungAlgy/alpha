import { LegalLayout } from "@/components/LegalLayout";

export const metadata = { title: "Privacy — Alpha" };

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy" effectiveDate="May 13, 2026">
      <p>
        Alpha is a personal weekly newsletter service. We try to collect as little
        about you as we need to write you a good letter, and we don&apos;t sell or share
        your data with advertisers — ever.
      </p>

      <H2>What we collect</H2>
      <p>When you sign up and use Alpha, we store:</p>
      <ul>
        <li>
          <strong>Account basics:</strong> your first name, email address, and city.
        </li>
        <li>
          <strong>Your interests:</strong> the topics you picked (5–25 depending on
          your plan tier), your chosen theme, and any optional context you shared
          (what you do, what you&apos;re working on, a non-work interest).
        </li>
        <li>
          <strong>Letters we write you:</strong> a copy of each weekly letter is saved
          to your account so you can re-read past issues.
        </li>
        <li>
          <strong>Usage signals:</strong> when you open the app, which letters you
          read, and basic device info — used only to improve the product, never sold.
        </li>
      </ul>

      <H2>How we use it</H2>
      <p>
        We use your data only to (a) generate and deliver your weekly letter,
        (b) bill your subscription, and (c) improve Alpha. We don&apos;t use it to
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
          <strong>Resend</strong> delivers letters and account emails.
        </li>
        <li>
          <strong>Supabase</strong> stores your account and letter history securely.
        </li>
        <li>
          <strong>Vercel</strong> hosts the web app.
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
        We use only the cookies needed to keep you logged in and remember your
        theme. No advertising cookies, no third-party tracking pixels.
      </p>

      <H2>Children</H2>
      <p>Alpha is for adults. We do not knowingly collect data from anyone under 13.</p>

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
        This policy is a plain-English description of how Alpha handles your
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
