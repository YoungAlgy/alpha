import Link from "next/link";

// alpha-drift-r19-01 (found+fixed 2026-08-07): a plain string title here
// gets the root layout's title.template ("%s · alpha.") appended on top of
// it, same as any other page -- but this string already ended in "alpha.",
// so the browser tab read "Lost? | alpha. · alpha." (doubled). Every other
// page in the app sets a bare page name (e.g. app/privacy/page.tsx: "Privacy")
// and lets the template add its own single "· alpha." suffix; this is the
// one page that baked the suffix in by hand.
export const metadata = { title: "Lost?" };

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md space-y-8">
        <div
          className="alpha-display text-9xl md:text-[10rem] font-bold leading-none"
          style={{ color: "var(--accent-ink)", opacity: 0.85 }}
        >
          α<span style={{ color: "var(--ink-soft)" }}>?</span>
        </div>
        <h1 className="alpha-display text-3xl md:text-4xl font-bold tracking-tight">
          That page doesn&apos;t exist.
        </h1>
        <p
          className="alpha-display text-lg leading-relaxed"
          style={{ color: "var(--ink-soft)" }}
        >
          Maybe a stale link, or maybe a typo. Either way, come on home.
        </p>
        <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/welcome" className="alpha-button">
            Start fresh →
          </Link>
          {/* alpha-drift-r59-05 (2026-08-20, accessibility-resweep-newer-
              code-round-7): same touch-target fix as app/error.tsx's
              identical sibling link. */}
          <Link
            href="/inbox"
            className="alpha-ui text-sm underline underline-offset-4 py-2 -my-2"
            style={{ color: "var(--ink-soft)" }}
          >
            Or open your inbox
          </Link>
        </div>
      </div>
    </main>
  );
}
