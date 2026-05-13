import Link from "next/link";
import { StepShell } from "@/components/onboarding/StepShell";

export default function WelcomePage() {
  return (
    <StepShell stepIndex={1}>
      <div className="relative">
        <span aria-hidden className="alpha-watermark" style={{ top: "-22vmin", left: "50%", transform: "translateX(-50%)" }}>
          α
        </span>
        <div className="relative z-10 text-center space-y-10">
          <h1 className="alpha-display alpha-hero text-5xl md:text-7xl font-bold tracking-tight leading-[1.05]">
            Your weekly{" "}
            <em style={{ color: "var(--accent-ink)", fontStyle: "italic" }}>
              alpha.
            </em>
          </h1>
          <p
            className="alpha-display text-xl md:text-2xl leading-relaxed max-w-lg mx-auto"
            style={{ color: "var(--ink-soft)" }}
          >
            A personal letter on what matters to you, every Sunday.
          </p>
          <div className="pt-4">
            <Link href="/name" className="alpha-button text-base">
              Let&apos;s get to know you →
            </Link>
          </div>
        </div>
      </div>
    </StepShell>
  );
}
