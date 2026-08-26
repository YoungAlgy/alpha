interface ProgressDotsProps {
  current: number; // 1-based step index
  total: number;
}

export function ProgressDots({ current, total }: ProgressDotsProps) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="progressbar"
      // alpha-drift-r76-01 (2026-08-21, accessibility-resweep-newer-code-
      // r24): role="progressbar" requires an accessible name (WCAG 4.1.2 --
      // aria-valuetext supplies the live value, not the name); this had
      // neither aria-label nor aria-labelledby, and no ancestor (a bare
      // <nav> in StepShell.tsx) supplied one either. Static label, separate
      // from aria-valuetext's own "Step X of Y".
      aria-label="Onboarding progress"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuetext={`Step ${current} of ${total}`}
    >
      {Array.from({ length: total }).map((_, i) => {
        const idx = i + 1;
        const filled = idx <= current;
        return (
          <span
            key={i}
            className="block rounded-full transition-all"
            style={{
              width: idx === current ? "20px" : "6px",
              height: "6px",
              background: filled ? "var(--accent)" : "var(--rule)",
            }}
          />
        );
      })}
    </div>
  );
}
