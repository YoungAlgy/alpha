import Link from "next/link";
import { Wordmark } from "./Wordmark";

export function Footer() {
  return (
    <footer
      className="px-6 py-10 max-w-5xl mx-auto w-full flex flex-col md:flex-row items-center justify-between gap-3 border-t"
      style={{ borderColor: "var(--rule)" }}
    >
      <div
        className="alpha-mono"
        style={{ color: "var(--ink-soft)" }}
      >
        <Wordmark /> · {new Date().getFullYear()}
      </div>
      <div className="flex gap-6 alpha-ui text-xs" style={{ color: "var(--ink-soft)" }}>
        <Link href="/privacy" className="hover:opacity-70">Privacy</Link>
        <Link href="/terms" className="hover:opacity-70">Terms</Link>
        <Link href="/support" className="hover:opacity-70">Support</Link>
      </div>
    </footer>
  );
}
